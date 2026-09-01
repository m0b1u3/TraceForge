#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

mod cleanup;

#[cfg(target_os = "windows")]
mod conpty;

#[cfg(target_os = "windows")]
mod job_limits;

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("traceforge-windows-sandbox is only available on Windows");
    std::process::exit(125);
}

#[cfg(target_os = "windows")]
mod windows_main {
    use crate::job_limits::{
        configure as configure_job_limits, terminate_and_wait, ResourceLimits, ResourceMonitor,
    };
    use std::ffi::{c_void, OsStr};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, HANDLE, HLOCAL, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, GetSecurityInfo, SetEntriesInAclW, SetNamedSecurityInfoW,
        SetSecurityInfo, DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS, SET_ACCESS,
        SE_FILE_OBJECT, SE_WINDOW_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        AdjustTokenPrivileges, CreateRestrictedToken, FreeSid, GetTokenInformation,
        LookupPrivilegeValueW, SetTokenInformation, TokenDefaultDacl, TokenIsAppContainer, ACL,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, LUA_TOKEN,
        OBJECT_INHERIT_ACE, PSID, SECURITY_CAPABILITIES, SE_PRIVILEGE_ENABLED, SID_AND_ATTRIBUTES,
        TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_APPEND_DATA, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, CreateDesktopW, GetProcessWindowStation, DESKTOP_CREATEWINDOW,
        DESKTOP_ENUMERATE, DESKTOP_READOBJECTS, DESKTOP_SWITCHDESKTOP, DESKTOP_WRITEOBJECTS, HDESK,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetCurrentProcessId, GetExitCodeProcess, InitializeProcThreadAttributeList,
        OpenProcessToken, ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };
    use windows_sys::Win32::System::WindowsProgramming::PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;

    const GENERIC_ALL: u32 = 0x1000_0000;
    const WINSTA_ENUMDESKTOPS: u32 = 0x0001;
    const WINSTA_READATTRIBUTES: u32 = 0x0002;
    const WINSTA_ACCESSGLOBALATOMS: u32 = 0x0020;
    const SANDBOX_WINDOW_STATION_ACCESS: u32 =
        WINSTA_ENUMDESKTOPS | WINSTA_READATTRIBUTES | WINSTA_ACCESSGLOBALATOMS;
    const WRITE_DENY_MASK: u32 = FILE_GENERIC_WRITE
        | FILE_WRITE_DATA
        | FILE_APPEND_DATA
        | FILE_WRITE_EA
        | FILE_WRITE_ATTRIBUTES
        | DELETE;

    #[derive(Clone)]
    struct PathRule {
        path: PathBuf,
        tree: bool,
    }

    #[derive(Default)]
    struct FileSystemPolicy {
        read: Vec<PathRule>,
        write: Vec<PathRule>,
        deny: Vec<PathRule>,
    }

    enum PathAccess {
        Read,
        Write,
        Deny,
    }

    type Result<T> = std::result::Result<T, String>;

    macro_rules! bail {
        ($($arg:tt)*) => { return Err(format!($($arg)*)) };
    }

    trait ResultContext<T> {
        fn with_context(self, context: impl FnOnce() -> String) -> Result<T>;
    }

    impl<T, E: std::fmt::Display> ResultContext<T> for std::result::Result<T, E> {
        fn with_context(self, context: impl FnOnce() -> String) -> Result<T> {
            self.map_err(|error| format!("{}: {error}", context()))
        }
    }

    struct LocalSid(*mut c_void);
    impl Drop for LocalSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0 as HLOCAL);
                }
            }
        }
    }

    struct AppContainerSid {
        sid: PSID,
        profile_name: Vec<u16>,
    }
    impl AppContainerSid {
        unsafe fn delete_profile(&mut self) -> Result<()> {
            if self.profile_name.is_empty() {
                return Ok(());
            }
            let status = DeleteAppContainerProfile(self.profile_name.as_ptr());
            if status < 0 {
                bail!("DeleteAppContainerProfile failed: HRESULT {status}");
            }
            self.profile_name.clear();
            Ok(())
        }
    }
    impl Drop for AppContainerSid {
        fn drop(&mut self) {
            unsafe {
                if !self.profile_name.is_empty() {
                    DeleteAppContainerProfile(self.profile_name.as_ptr());
                }
                if !self.sid.is_null() {
                    FreeSid(self.sid);
                }
            }
        }
    }

    struct PreparedProfile {
        capability: LocalSid,
        token: Handle,
        app_container: Option<AppContainerSid>,
        policy: FileSystemPolicy,
    }

    struct SecurityAttributeList {
        storage: Vec<u8>,
        job: Box<[HANDLE; 1]>,
        all_application_packages_policy: Box<u32>,
        initialized: bool,
    }

    impl SecurityAttributeList {
        unsafe fn new(
            job: HANDLE,
            capabilities: Option<&mut SECURITY_CAPABILITIES>,
        ) -> Result<Self> {
            let attribute_count = if capabilities.is_some() { 3 } else { 1 };
            let mut bytes = 0usize;
            InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut bytes);
            if bytes == 0 {
                bail!(
                    "InitializeProcThreadAttributeList sizing failed: {}",
                    GetLastError()
                );
            }
            let mut value = Self {
                storage: vec![0u8; bytes],
                job: Box::new([job]),
                all_application_packages_policy: Box::new(
                    PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT,
                ),
                initialized: false,
            };
            if InitializeProcThreadAttributeList(value.as_mut_ptr(), attribute_count, 0, &mut bytes)
                == 0
            {
                bail!(
                    "InitializeProcThreadAttributeList failed: {}",
                    GetLastError()
                );
            }
            value.initialized = true;
            const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000D;
            if UpdateProcThreadAttribute(
                value.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                value.job.as_ptr() as *const c_void,
                std::mem::size_of::<[HANDLE; 1]>(),
                null_mut(),
                null(),
            ) == 0
            {
                bail!("UpdateProcThreadAttribute(Job) failed: {}", GetLastError());
            }
            let Some(capabilities) = capabilities else {
                return Ok(value);
            };
            if UpdateProcThreadAttribute(
                value.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                capabilities as *mut _ as *const c_void,
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            ) == 0
            {
                bail!(
                    "UpdateProcThreadAttribute(SecurityCapabilities) failed: {}",
                    GetLastError()
                );
            }
            if UpdateProcThreadAttribute(
                value.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
                value.all_application_packages_policy.as_ref() as *const u32 as *const c_void,
                std::mem::size_of::<u32>(),
                null_mut(),
                null(),
            ) == 0
            {
                bail!(
                    "UpdateProcThreadAttribute(AllApplicationPackagesPolicy) failed: {}",
                    GetLastError()
                );
            }
            Ok(value)
        }

        fn as_mut_ptr(&mut self) -> *mut c_void {
            self.storage.as_mut_ptr() as *mut c_void
        }
    }

    impl Drop for SecurityAttributeList {
        fn drop(&mut self) {
            if self.initialized {
                unsafe {
                    DeleteProcThreadAttributeList(self.as_mut_ptr());
                }
            }
        }
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct Desktop(HDESK);
    impl Drop for Desktop {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseDesktop(self.0);
                }
            }
        }
    }

    #[repr(C)]
    struct TokenDefaultDaclInfo {
        default_dacl: *mut ACL,
    }

    fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
        value
            .as_ref()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn sid_components(seed: &str) -> [u32; 4] {
        let mut state = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58du128;
        for byte in seed.bytes() {
            state ^= byte as u128;
            state = state.wrapping_mul(0x0000_0000_0100_0000_0000_0000_0000_013bu128);
            state ^= state.rotate_left(47);
        }
        [
            state as u32,
            (state >> 32) as u32,
            (state >> 64) as u32,
            (state >> 96) as u32,
        ]
    }

    fn capability_sid(seed: &str) -> String {
        let components = sid_components(seed);
        format!(
            "S-1-5-21-{}-{}-{}-{}",
            components[0], components[1], components[2], components[3],
        )
    }

    unsafe fn app_container_sid() -> Result<AppContainerSid> {
        const ALREADY_EXISTS: i32 = 0x8007_00b7u32 as i32;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("system clock is before Unix epoch: {error}"))?
            .as_nanos();
        let name = wide(format!(
            "TraceForge.SecuritySandbox.{}.{nonce:x}",
            GetCurrentProcessId()
        ));
        let display_name = wide("TraceForge Security Sandbox");
        let description = wide("Network-isolated TraceForge execution container");
        let mut sid: PSID = null_mut();
        let created = CreateAppContainerProfile(
            name.as_ptr(),
            display_name.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        );
        if created == ALREADY_EXISTS {
            let derived = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid);
            if derived < 0 {
                bail!("DeriveAppContainerSidFromAppContainerName failed: HRESULT {derived}");
            }
        } else if created < 0 {
            bail!("CreateAppContainerProfile failed: HRESULT {created}");
        }
        if sid.is_null() {
            bail!("AppContainer profile returned an empty SID");
        }
        Ok(AppContainerSid {
            sid,
            profile_name: name,
        })
    }

    fn sid_from_string(value: &str) -> Result<LocalSid> {
        #[link(name = "advapi32")]
        extern "system" {
            fn ConvertStringSidToSidW(value: *const u16, sid: *mut *mut c_void) -> i32;
        }
        let mut sid = null_mut();
        let ok = unsafe { ConvertStringSidToSidW(wide(value).as_ptr(), &mut sid) };
        if ok == 0 {
            bail!("ConvertStringSidToSidW failed: {}", unsafe {
                GetLastError()
            });
        }
        Ok(LocalSid(sid))
    }

    unsafe fn add_path_ace(
        path: &Path,
        sid: *mut c_void,
        access: PathAccess,
        tree: bool,
    ) -> Result<()> {
        let mut old_dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let path_w = wide(path.as_os_str());
        let status = GetNamedSecurityInfoW(
            path_w.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_dacl,
            null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            bail!(
                "GetNamedSecurityInfoW failed for {}: {status}",
                path.display()
            );
        }
        let mut entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: match access {
                PathAccess::Read => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                PathAccess::Write => WRITE_DENY_MASK,
                PathAccess::Deny => GENERIC_ALL,
            },
            grfAccessMode: if matches!(access, PathAccess::Deny) {
                DENY_ACCESS
            } else {
                GRANT_ACCESS
            },
            grfInheritance: if tree {
                CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
            } else {
                0
            },
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let mut new_dacl = null_mut();
        let acl_status = SetEntriesInAclW(1, &mut entry, old_dacl, &mut new_dacl);
        if acl_status != 0 {
            if !descriptor.is_null() {
                LocalFree(descriptor as HLOCAL);
            }
            bail!(
                "SetEntriesInAclW failed for {}: {acl_status}",
                path.display()
            );
        }
        let set_status = SetNamedSecurityInfoW(
            path_w.as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_dacl,
            null_mut(),
        );
        if !new_dacl.is_null() {
            LocalFree(new_dacl as HLOCAL);
        }
        if !descriptor.is_null() {
            LocalFree(descriptor as HLOCAL);
        }
        if set_status != 0 {
            bail!(
                "SetNamedSecurityInfoW failed for {}: {set_status}",
                path.display()
            );
        }
        Ok(())
    }

    unsafe fn revoke_path_aces(path: &Path, sid: *mut c_void) -> Result<()> {
        let mut old_dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let path_w = wide(path.as_os_str());
        let status = GetNamedSecurityInfoW(
            path_w.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_dacl,
            null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            bail!(
                "GetNamedSecurityInfoW cleanup failed for {}: {status}",
                path.display()
            );
        }
        let mut entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: 0,
            grfAccessMode: REVOKE_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let mut new_dacl = null_mut();
        let acl_status = SetEntriesInAclW(1, &mut entry, old_dacl, &mut new_dacl);
        if acl_status != 0 {
            if !descriptor.is_null() {
                LocalFree(descriptor as HLOCAL);
            }
            bail!(
                "SetEntriesInAclW cleanup failed for {}: {acl_status}",
                path.display()
            );
        }
        let set_status = SetNamedSecurityInfoW(
            path_w.as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_dacl,
            null_mut(),
        );
        if !new_dacl.is_null() {
            LocalFree(new_dacl as HLOCAL);
        }
        if !descriptor.is_null() {
            LocalFree(descriptor as HLOCAL);
        }
        if set_status != 0 {
            bail!(
                "SetNamedSecurityInfoW cleanup failed for {}: {set_status}",
                path.display()
            );
        }
        Ok(())
    }

    unsafe fn set_default_dacl(token: HANDLE, sid: *mut c_void) -> Result<()> {
        let mut entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: SET_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let mut dacl = null_mut();
        let status = SetEntriesInAclW(1, &mut entry, null_mut(), &mut dacl);
        if status != 0 {
            bail!("SetEntriesInAclW(default DACL) failed: {status}");
        }
        let mut info = TokenDefaultDaclInfo { default_dacl: dacl };
        let ok = SetTokenInformation(
            token,
            TokenDefaultDacl,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
        );
        if !dacl.is_null() {
            LocalFree(dacl as HLOCAL);
        }
        if ok == 0 {
            bail!(
                "SetTokenInformation(TokenDefaultDacl) failed: {}",
                GetLastError()
            );
        }
        Ok(())
    }

    unsafe fn enable_change_notify(token: HANDLE) -> Result<()> {
        let mut luid = std::mem::zeroed();
        if LookupPrivilegeValueW(null(), wide("SeChangeNotifyPrivilege").as_ptr(), &mut luid) == 0 {
            bail!("LookupPrivilegeValueW failed: {}", GetLastError());
        }
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [windows_sys::Win32::Security::LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        if AdjustTokenPrivileges(token, 0, &privileges, 0, null_mut(), null_mut()) == 0 {
            bail!("AdjustTokenPrivileges failed: {}", GetLastError());
        }
        Ok(())
    }

    unsafe fn restricted_token(capability: *mut c_void) -> Result<Handle> {
        let desired = TOKEN_DUPLICATE
            | TOKEN_QUERY
            | TOKEN_ASSIGN_PRIMARY
            | TOKEN_ADJUST_DEFAULT
            | TOKEN_ADJUST_SESSIONID
            | TOKEN_ADJUST_PRIVILEGES;
        let mut base: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), desired, &mut base) == 0 {
            bail!("OpenProcessToken failed: {}", GetLastError());
        }
        let base = Handle(base);
        let mut restricted: HANDLE = null_mut();
        let mut restrictions = [SID_AND_ATTRIBUTES {
            Sid: capability,
            Attributes: 0,
        }];
        let ok = CreateRestrictedToken(
            base.0,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
            0,
            null(),
            0,
            null(),
            restrictions.len() as u32,
            restrictions.as_mut_ptr(),
            &mut restricted,
        );
        if ok == 0 {
            bail!("CreateRestrictedToken failed: {}", GetLastError());
        }
        let restricted = Handle(restricted);
        set_default_dacl(restricted.0, capability)?;
        enable_change_notify(restricted.0)?;
        Ok(restricted)
    }

    fn quote_arg(value: &OsStr) -> String {
        let value = value.to_string_lossy();
        if !value.is_empty() && !value.contains([' ', '\t', '"']) {
            return value.into_owned();
        }
        let mut out = String::from("\"");
        let mut slashes = 0;
        for ch in value.chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            if ch == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
            } else {
                out.push_str(&"\\".repeat(slashes));
                out.push(ch);
            }
            slashes = 0;
        }
        out.push_str(&"\\".repeat(slashes * 2));
        out.push('"');
        out
    }

    unsafe fn grant_window_object_access(
        object: HANDLE,
        sid: *mut c_void,
        permissions: u32,
        label: &str,
    ) -> Result<()> {
        let mut old_dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let status = GetSecurityInfo(
            object,
            SE_WINDOW_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_dacl,
            null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            bail!("GetSecurityInfo({label}) failed: {status}");
        }
        let mut entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: permissions,
            grfAccessMode: SET_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let mut new_dacl = null_mut();
        let acl_status = SetEntriesInAclW(1, &mut entry, old_dacl, &mut new_dacl);
        if acl_status != 0 {
            if !descriptor.is_null() {
                LocalFree(descriptor as HLOCAL);
            }
            bail!("SetEntriesInAclW({label}) failed: {acl_status}");
        }
        let set_status = SetSecurityInfo(
            object,
            SE_WINDOW_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_dacl,
            null_mut(),
        );
        if !new_dacl.is_null() {
            LocalFree(new_dacl as HLOCAL);
        }
        if !descriptor.is_null() {
            LocalFree(descriptor as HLOCAL);
        }
        if set_status != 0 {
            bail!("SetSecurityInfo({label}) failed: {set_status}");
        }
        Ok(())
    }

    unsafe fn revoke_window_object_access(object: HANDLE, sid: *mut c_void) -> Result<()> {
        let mut old_dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let status = GetSecurityInfo(
            object,
            SE_WINDOW_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_dacl,
            null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            bail!("GetSecurityInfo(window station cleanup) failed: {status}");
        }
        let mut entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: 0,
            grfAccessMode: REVOKE_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            },
        };
        let mut new_dacl = null_mut();
        let acl_status = SetEntriesInAclW(1, &mut entry, old_dacl, &mut new_dacl);
        if acl_status != 0 {
            if !descriptor.is_null() {
                LocalFree(descriptor as HLOCAL);
            }
            bail!("SetEntriesInAclW(window station cleanup) failed: {acl_status}");
        }
        let set_status = SetSecurityInfo(
            object,
            SE_WINDOW_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_dacl,
            null_mut(),
        );
        if !new_dacl.is_null() {
            LocalFree(new_dacl as HLOCAL);
        }
        if !descriptor.is_null() {
            LocalFree(descriptor as HLOCAL);
        }
        if set_status != 0 {
            bail!("SetSecurityInfo(window station cleanup) failed: {set_status}");
        }
        Ok(())
    }

    unsafe fn create_private_desktop(
        capability: *mut c_void,
        app_container: Option<PSID>,
    ) -> Result<(Desktop, Vec<u16>)> {
        let window_station = GetProcessWindowStation();
        if window_station.is_null() {
            bail!("GetProcessWindowStation failed: {}", GetLastError());
        }
        grant_window_object_access(
            window_station,
            capability,
            SANDBOX_WINDOW_STATION_ACCESS,
            "window station",
        )?;
        if let Some(app_container) = app_container {
            grant_window_object_access(
                window_station,
                app_container,
                SANDBOX_WINDOW_STATION_ACCESS,
                "window station",
            )?;
        }
        let name = format!("TraceForgeSandbox-{}", GetCurrentProcessId());
        let name_w = wide(&name);
        let desktop = CreateDesktopW(
            name_w.as_ptr(),
            null(),
            null_mut(),
            0,
            DESKTOP_CREATEWINDOW
                | DESKTOP_ENUMERATE
                | DESKTOP_READOBJECTS
                | DESKTOP_WRITEOBJECTS
                | DESKTOP_SWITCHDESKTOP,
            null(),
        );
        if desktop.is_null() {
            bail!("CreateDesktopW failed: {}", GetLastError());
        }
        let desktop_access = DESKTOP_CREATEWINDOW
            | DESKTOP_ENUMERATE
            | DESKTOP_READOBJECTS
            | DESKTOP_WRITEOBJECTS
            | DESKTOP_SWITCHDESKTOP;
        grant_window_object_access(desktop, capability, desktop_access, "private desktop")?;
        if let Some(app_container) = app_container {
            grant_window_object_access(desktop, app_container, desktop_access, "private desktop")?;
        }
        Ok((Desktop(desktop), wide(format!("winsta0\\{name}"))))
    }

    unsafe fn assert_app_container_process(process: HANDLE) -> Result<()> {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            bail!("OpenProcessToken(child) failed: {}", GetLastError());
        }
        let token = Handle(token);
        let mut isolated = 0u32;
        let mut returned = 0u32;
        if GetTokenInformation(
            token.0,
            TokenIsAppContainer,
            &mut isolated as *mut _ as *mut c_void,
            std::mem::size_of_val(&isolated) as u32,
            &mut returned,
        ) == 0
        {
            bail!(
                "GetTokenInformation(TokenIsAppContainer) failed: {}",
                GetLastError()
            );
        }
        if isolated == 0 {
            bail!("child token is not AppContainer-isolated; execution denied");
        }
        Ok(())
    }

    fn canonicalize_policy(policy: &FileSystemPolicy) -> Result<FileSystemPolicy> {
        let canonicalize = |rule: &PathRule| -> Result<PathRule> {
            if !rule.path.is_absolute() {
                bail!(
                    "filesystem policy path must be absolute: {}",
                    rule.path.display()
                );
            }
            let path = fs::canonicalize(&rule.path)
                .with_context(|| format!("canonicalize policy path {}", rule.path.display()))?;
            Ok(PathRule {
                path,
                tree: rule.tree,
            })
        };
        Ok(FileSystemPolicy {
            read: policy
                .read
                .iter()
                .map(canonicalize)
                .collect::<Result<Vec<_>>>()?,
            write: policy
                .write
                .iter()
                .map(canonicalize)
                .collect::<Result<Vec<_>>>()?,
            deny: policy
                .deny
                .iter()
                .map(canonicalize)
                .collect::<Result<Vec<_>>>()?,
        })
    }

    fn policy_seed(cwd: &Path, policy: &FileSystemPolicy) -> String {
        let mut values = vec![format!("cwd:{}", cwd.to_string_lossy().to_lowercase())];
        for (kind, rules) in [
            ("r", &policy.read),
            ("w", &policy.write),
            ("d", &policy.deny),
        ] {
            values.extend(rules.iter().map(|rule| {
                format!(
                    "{kind}:{}:{}",
                    if rule.tree { "tree" } else { "exact" },
                    rule.path.to_string_lossy().to_lowercase(),
                )
            }));
        }
        values.sort();
        values.join("|")
    }

    unsafe fn prepare_profiled_token(
        cwd: &Path,
        policy: &FileSystemPolicy,
        network_isolated: bool,
    ) -> Result<PreparedProfile> {
        let policy = canonicalize_policy(policy)?;
        let canonical_cwd =
            fs::canonicalize(cwd).with_context(|| format!("canonicalize {}", cwd.display()))?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("system clock is before Unix epoch: {error}"))?
            .as_nanos();
        let sid_text = capability_sid(&format!(
            "{}|process:{}|nonce:{nonce:x}",
            policy_seed(&canonical_cwd, &policy),
            GetCurrentProcessId(),
        ));
        let sid = sid_from_string(&sid_text)?;
        let app_container = if network_isolated {
            Some(app_container_sid()?)
        } else {
            None
        };
        let token = restricted_token(sid.0)?;
        let mut prepared = PreparedProfile {
            capability: sid,
            token,
            app_container,
            policy,
        };
        let applied = (|| -> Result<()> {
            for rule in &prepared.policy.read {
                add_path_ace(
                    &rule.path,
                    prepared.capability.0,
                    PathAccess::Read,
                    rule.tree,
                )?;
                if let Some(app_container) = &prepared.app_container {
                    add_path_ace(&rule.path, app_container.sid, PathAccess::Read, rule.tree)?;
                }
            }
            for rule in &prepared.policy.write {
                add_path_ace(
                    &rule.path,
                    prepared.capability.0,
                    PathAccess::Write,
                    rule.tree,
                )?;
                if let Some(app_container) = &prepared.app_container {
                    add_path_ace(&rule.path, app_container.sid, PathAccess::Write, rule.tree)?;
                }
            }
            for rule in &prepared.policy.deny {
                add_path_ace(
                    &rule.path,
                    prepared.capability.0,
                    PathAccess::Deny,
                    rule.tree,
                )?;
                if let Some(app_container) = &prepared.app_container {
                    add_path_ace(&rule.path, app_container.sid, PathAccess::Deny, rule.tree)?;
                }
            }
            Ok(())
        })();
        if let Err(error) = applied {
            let cleanup = cleanup_profile(&mut prepared);
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
            });
        }
        Ok(prepared)
    }

    unsafe fn cleanup_profile(profile: &mut PreparedProfile) -> Result<()> {
        let mut errors = Vec::new();
        for rule in profile
            .policy
            .read
            .iter()
            .chain(profile.policy.write.iter())
            .chain(profile.policy.deny.iter())
        {
            if let Err(error) = revoke_path_aces(&rule.path, profile.capability.0) {
                errors.push(error);
            }
            if let Some(app_container) = &profile.app_container {
                if let Err(error) = revoke_path_aces(&rule.path, app_container.sid) {
                    errors.push(error);
                }
            }
        }
        let window_station = GetProcessWindowStation();
        if !window_station.is_null() {
            if let Err(error) = revoke_window_object_access(window_station, profile.capability.0) {
                errors.push(error);
            }
            if let Some(app_container) = &profile.app_container {
                if let Err(error) = revoke_window_object_access(window_station, app_container.sid) {
                    errors.push(error);
                }
            }
        }
        if let Some(app_container) = profile.app_container.as_mut() {
            if let Err(error) = app_container.delete_profile() {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn finish_with_cleanup(result: Result<i32>, cleanup: Result<()>) -> Result<i32> {
        match (result, cleanup) {
            (Ok(code), Ok(())) => Ok(code),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(cleanup_error)) => Err(format!("sandbox cleanup failed: {cleanup_error}")),
            (Err(error), Err(cleanup_error)) => {
                Err(format!("{error}; sandbox cleanup failed: {cleanup_error}"))
            }
        }
    }

    unsafe fn run_restricted(
        cwd: &Path,
        command: &[String],
        network_isolated: bool,
        policy: &FileSystemPolicy,
        resource_limits: ResourceLimits,
        status_file: &Path,
    ) -> Result<i32> {
        if command.is_empty() {
            bail!("missing command");
        }
        let job = Handle(CreateJobObjectW(null(), null()));
        if job.0.is_null() {
            bail!("CreateJobObjectW failed: {}", GetLastError());
        }
        configure_job_limits(job.0, resource_limits)?;
        let mut profile = prepare_profiled_token(cwd, policy, network_isolated)?;
        let execution = (|| -> Result<i32> {
            let (_desktop, mut desktop_name) = create_private_desktop(
                profile.capability.0,
                profile.app_container.as_ref().map(|value| value.sid),
            )?;
            let command_line = command
                .iter()
                .map(|arg| quote_arg(OsStr::new(arg)))
                .collect::<Vec<_>>()
                .join(" ");
            let mut command_w = wide(command_line);
            let cwd_w = wide(cwd.as_os_str());
            let mut security_capabilities = profile.app_container.as_ref().map(|value| {
                Box::new(SECURITY_CAPABILITIES {
                    AppContainerSid: value.sid,
                    Capabilities: null_mut(),
                    CapabilityCount: 0,
                    Reserved: 0,
                })
            });
            let mut attributes =
                SecurityAttributeList::new(job.0, security_capabilities.as_deref_mut())?;
            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            startup.StartupInfo.lpDesktop = desktop_name.as_mut_ptr();
            startup.lpAttributeList = attributes.as_mut_ptr();
            let creation_flags =
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessAsUserW(
                profile.token.0,
                null(),
                command_w.as_mut_ptr(),
                null(),
                null(),
                1,
                creation_flags,
                null(),
                cwd_w.as_ptr(),
                &startup.StartupInfo,
                &mut process,
            );
            if ok == 0 {
                bail!("CreateProcessAsUserW failed: {}", GetLastError());
            }
            let process_handle = Handle(process.hProcess);
            let thread_handle = Handle(process.hThread);
            // Job membership is atomic with creation: a killed helper cannot leave an unassigned child.
            if network_isolated {
                assert_app_container_process(process_handle.0)?;
            }
            if ResumeThread(thread_handle.0) == u32::MAX {
                bail!("ResumeThread failed: {}", GetLastError());
            }
            let monitor = ResourceMonitor::start(job.0, resource_limits);
            if WaitForSingleObject(process_handle.0, INFINITE) != WAIT_OBJECT_0 {
                bail!("WaitForSingleObject(child) failed: {}", GetLastError());
            }
            if let Some(resource) = monitor.finish()? {
                let mut status = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(status_file)
                    .with_context(|| format!("create resource status {}", status_file.display()))?;
                status
                    .write_all(resource.as_str().as_bytes())
                    .with_context(|| format!("write resource status {}", status_file.display()))?;
                bail!("resource limit exceeded: {}", resource.as_str());
            }
            let mut exit_code = 1;
            if GetExitCodeProcess(process_handle.0, &mut exit_code) == 0 {
                bail!("GetExitCodeProcess failed: {}", GetLastError());
            }
            Ok(exit_code as i32)
        })();
        // This also covers errors after assignment; never report success from handle-close alone.
        let execution = finish_with_cleanup(execution, terminate_and_wait(job.0));
        let cleanup = cleanup_profile(&mut profile);
        finish_with_cleanup(execution, cleanup)
    }

    unsafe fn run_restricted_pty(
        cwd: &Path,
        command: &[String],
        network_isolated: bool,
        policy: &FileSystemPolicy,
        resource_limits: ResourceLimits,
        columns: i16,
        rows: i16,
        execution_nonce: &str,
    ) -> Result<i32> {
        if command.is_empty() {
            bail!("missing command");
        }
        let job = Handle(CreateJobObjectW(null(), null()));
        if job.0.is_null() {
            bail!("CreateJobObjectW failed: {}", GetLastError());
        }
        configure_job_limits(job.0, resource_limits)?;
        let mut profile = prepare_profiled_token(cwd, policy, network_isolated)?;
        let execution = (|| -> Result<i32> {
            let (_desktop, mut desktop_name) = create_private_desktop(
                profile.capability.0,
                profile.app_container.as_ref().map(|value| value.sid),
            )?;
            crate::conpty::run(
                profile.token.0,
                cwd,
                command,
                desktop_name.as_mut_ptr(),
                profile.app_container.as_ref().map(|value| value.sid),
                resource_limits,
                columns,
                rows,
                job.0,
            )
        })();
        let execution = finish_with_cleanup(execution, terminate_and_wait(job.0));
        let cleanup = cleanup_profile(&mut profile);
        let code = finish_with_cleanup(execution, cleanup)?;
        // Completion is emitted only after job emptiness, output drain, and profile cleanup succeed.
        crate::conpty::send_completion(code, execution_nonce)?;
        Ok(code)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::CreateProcessW;

        #[test]
        fn stdio_child_is_owned_before_any_thread_can_resume() {
            unsafe {
                let job = Handle(CreateJobObjectW(null(), null()));
                assert!(!job.0.is_null());
                configure_job_limits(
                    job.0,
                    ResourceLimits {
                        cpu_time_ms: 30_000,
                        memory_bytes: 256 * 1024 * 1024,
                        maximum_processes: 8,
                        write_bytes: 1024 * 1024,
                    },
                )
                .unwrap();
                let mut attributes = SecurityAttributeList::new(job.0, None).unwrap();
                let mut startup: STARTUPINFOEXW = std::mem::zeroed();
                startup.StartupInfo.cb = std::mem::size_of_val(&startup) as u32;
                startup.lpAttributeList = attributes.as_mut_ptr();
                let executable = wide(std::env::current_exe().unwrap().as_os_str());
                let mut child: PROCESS_INFORMATION = std::mem::zeroed();
                assert_ne!(
                    CreateProcessW(
                        executable.as_ptr(),
                        null_mut(),
                        null(),
                        null(),
                        0,
                        CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                        null(),
                        null(),
                        &startup.StartupInfo,
                        &mut child
                    ),
                    0
                );
                let process = Handle(child.hProcess);
                let _thread = Handle(child.hThread);
                let mut owned = 0;
                assert_ne!(IsProcessInJob(process.0, job.0, &mut owned), 0);
                assert_ne!(owned, 0);
                terminate_and_wait(job.0).unwrap();
                assert_eq!(WaitForSingleObject(process.0, 5_000), WAIT_OBJECT_0);
            }
        }
    }

    pub fn run() -> Result<i32> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if args.first().map(String::as_str) == Some("probe") {
            println!(
                "{{\"protocol\":4,\"platform\":\"windows\",\"modes\":[\"unelevated-direct\",\"appcontainer-deny\"],\"pty\":true,\"jobEmptyBarrier\":true,\"atomicJobAssignment\":true,\"resourceLimits\":[\"cpu_time\",\"memory\",\"process_count\",\"write_bytes\"]}}"
            );
            return Ok(0);
        }
        let operation = args
            .first()
            .map(String::as_str)
            .ok_or_else(|| "expected run or pty-run command".to_string())?;
        if operation != "run" && operation != "pty-run" {
            bail!("expected run or pty-run command");
        }
        let mut mode = None;
        let mut network = None;
        let mut cwd = None;
        let mut columns = None;
        let mut rows = None;
        let mut status_file = None;
        let mut execution_nonce = None;
        let mut cpu_time_ms = None;
        let mut memory_bytes = None;
        let mut maximum_processes = None;
        let mut write_bytes = None;
        let mut filesystem = FileSystemPolicy::default();
        let mut index = 1;
        while index < args.len() {
            match args[index].as_str() {
                "--mode" => {
                    index += 1;
                    mode = args.get(index).cloned();
                }
                "--network" => {
                    index += 1;
                    network = args.get(index).cloned();
                }
                "--cwd" => {
                    index += 1;
                    cwd = args.get(index).map(PathBuf::from);
                }
                "--status-file" => {
                    index += 1;
                    status_file = args.get(index).map(PathBuf::from);
                }
                "--execution-nonce" => {
                    index += 1;
                    execution_nonce = args.get(index).cloned();
                }
                "--columns" => {
                    index += 1;
                    columns = args.get(index).and_then(|value| value.parse::<i16>().ok());
                }
                "--rows" => {
                    index += 1;
                    rows = args.get(index).and_then(|value| value.parse::<i16>().ok());
                }
                "--cpu-time-ms" => {
                    index += 1;
                    cpu_time_ms = args.get(index).and_then(|value| value.parse::<u64>().ok());
                }
                "--memory-bytes" => {
                    index += 1;
                    memory_bytes = args.get(index).and_then(|value| value.parse::<u64>().ok());
                }
                "--max-processes" => {
                    index += 1;
                    maximum_processes = args.get(index).and_then(|value| value.parse::<u32>().ok());
                }
                "--write-bytes" => {
                    index += 1;
                    write_bytes = args.get(index).and_then(|value| value.parse::<u64>().ok());
                }
                "--read-exact" | "--read-tree" | "--write-exact" | "--write-tree"
                | "--deny-exact" | "--deny-tree" => {
                    let option = args[index].clone();
                    index += 1;
                    let path = args
                        .get(index)
                        .map(PathBuf::from)
                        .ok_or_else(|| format!("missing path for {option}"))?;
                    let rule = PathRule {
                        path,
                        tree: option.ends_with("-tree"),
                    };
                    if option.starts_with("--read-") {
                        filesystem.read.push(rule);
                    } else if option.starts_with("--write-") {
                        filesystem.write.push(rule);
                    } else {
                        filesystem.deny.push(rule);
                    }
                }
                _ => break,
            }
            index += 1;
        }
        let mode = mode.ok_or_else(|| "missing --mode".to_string())?;
        let network = network.ok_or_else(|| "missing --network".to_string())?;
        let cwd = cwd.ok_or_else(|| "missing --cwd".to_string())?;
        let resource_limits = ResourceLimits {
            cpu_time_ms: cpu_time_ms
                .ok_or_else(|| "missing or invalid --cpu-time-ms".to_string())?,
            memory_bytes: memory_bytes
                .ok_or_else(|| "missing or invalid --memory-bytes".to_string())?,
            maximum_processes: maximum_processes
                .ok_or_else(|| "missing or invalid --max-processes".to_string())?,
            write_bytes: write_bytes
                .ok_or_else(|| "missing or invalid --write-bytes".to_string())?,
        };
        resource_limits.validate()?;
        if mode != "unelevated" && mode != "appcontainer" {
            bail!("unsupported Windows sandbox mode: {mode}");
        }
        if network != "allow" && network != "deny" {
            bail!("unsupported network policy: {network}");
        }
        if filesystem.read.is_empty() {
            bail!("filesystem policy requires at least one read grant");
        }
        let network_isolated = match (mode.as_str(), network.as_str()) {
            ("unelevated", "allow") => false,
            ("appcontainer", "deny") => true,
            _ => bail!("sandbox mode {mode} cannot prove network policy {network}"),
        };
        if operation == "pty-run" {
            let execution_nonce =
                execution_nonce.ok_or_else(|| "missing --execution-nonce".to_string())?;
            if execution_nonce.len() != 64
                || !execution_nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                bail!("invalid --execution-nonce");
            }
            let columns = columns.ok_or_else(|| "missing or invalid --columns".to_string())?;
            let rows = rows.ok_or_else(|| "missing or invalid --rows".to_string())?;
            if columns < 1 || rows < 1 {
                bail!("terminal dimensions must be positive");
            }
            unsafe {
                run_restricted_pty(
                    &cwd,
                    &args[index..],
                    network_isolated,
                    &filesystem,
                    resource_limits,
                    columns,
                    rows,
                    &execution_nonce,
                )
            }
        } else {
            let status_file = status_file.ok_or_else(|| "missing --status-file".to_string())?;
            unsafe {
                run_restricted(
                    &cwd,
                    &args[index..],
                    network_isolated,
                    &filesystem,
                    resource_limits,
                    &status_file,
                )
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn main() {
    match windows_main::run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("traceforge sandbox error: {error}");
            std::process::exit(125);
        }
    }
}
