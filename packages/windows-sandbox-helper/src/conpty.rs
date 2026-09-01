use crate::job_limits::{terminate_and_wait, ResourceLimits, ResourceMonitor};
use std::ffi::{c_void, OsStr};
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};
use std::thread;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_BROKEN_PIPE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenIsAppContainer, PSID, SECURITY_CAPABILITIES, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, UpdateProcThreadAttribute,
    WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use windows_sys::Win32::System::WindowsProgramming::PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;

const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000D;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
const PSEUDOCONSOLE_RESIZE_QUIRK: u32 = 0x2;
const FRAME_INPUT: u8 = 0x01;
const FRAME_RESIZE: u8 = 0x02;
const FRAME_CLOSE_INPUT: u8 = 0x03;
const FRAME_TERMINATE: u8 = 0x04;
const FRAME_STARTED: u8 = 0x81;
const FRAME_OUTPUT: u8 = 0x82;
const FRAME_EXITED: u8 = 0x83;
const FRAME_ACK: u8 = 0x84;
const FRAME_RESOURCE_LIMIT: u8 = 0x85;
const FRAME_ERROR: u8 = 0xff;
const MAX_FRAME_BYTES: usize = 1024 * 1024;

type Result<T> = std::result::Result<T, String>;

struct OwnedHandle(HANDLE);

unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct AttributeList {
    storage: Vec<u8>,
    job: Box<[HANDLE; 1]>,
    all_application_packages_policy: Option<Box<u32>>,
    initialized: bool,
}

impl AttributeList {
    unsafe fn new(
        pseudoconsole: HPCON,
        job: HANDLE,
        security_capabilities: Option<&mut SECURITY_CAPABILITIES>,
    ) -> Result<Self> {
        let attribute_count = if security_capabilities.is_some() {
            4
        } else {
            2
        };
        let mut bytes = 0usize;
        InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut bytes);
        if bytes == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList sizing failed: {}",
                GetLastError()
            ));
        }
        let mut value = Self {
            storage: vec![0u8; bytes],
            job: Box::new([job]),
            all_application_packages_policy: security_capabilities
                .as_ref()
                .map(|_| Box::new(PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT)),
            initialized: false,
        };
        if InitializeProcThreadAttributeList(value.as_mut_ptr(), attribute_count, 0, &mut bytes)
            == 0
        {
            return Err(format!(
                "InitializeProcThreadAttributeList failed: {}",
                GetLastError()
            ));
        }
        value.initialized = true;
        if UpdateProcThreadAttribute(
            value.as_mut_ptr(),
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            pseudoconsole as *const c_void,
            std::mem::size_of::<HPCON>(),
            null_mut(),
            null(),
        ) == 0
        {
            return Err(format!(
                "UpdateProcThreadAttribute(ConPTY) failed: {}",
                GetLastError()
            ));
        }
        if UpdateProcThreadAttribute(
            value.as_mut_ptr(),
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST,
            value.job.as_ptr() as *const c_void,
            std::mem::size_of_val(&value.job),
            null_mut(),
            null(),
        ) == 0
        {
            return Err(format!(
                "UpdateProcThreadAttribute(Job) failed: {}",
                GetLastError()
            ));
        }
        if let Some(capabilities) = security_capabilities {
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
                return Err(format!(
                    "UpdateProcThreadAttribute(SecurityCapabilities) failed: {}",
                    GetLastError()
                ));
            }
            let policy = value
                .all_application_packages_policy
                .as_ref()
                .map(|entry| entry.as_ref() as *const u32 as *const c_void)
                .ok_or_else(|| "AppContainer policy storage is unavailable".to_string())?;
            if UpdateProcThreadAttribute(
                value.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
                policy,
                std::mem::size_of::<u32>(),
                null_mut(),
                null(),
            ) == 0
            {
                return Err(format!(
                    "UpdateProcThreadAttribute(AllApplicationPackagesPolicy) failed: {}",
                    GetLastError()
                ));
            }
        }
        Ok(value)
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr() as *mut c_void
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
        }
    }
}

struct PseudoConsole {
    handle: Mutex<Option<HPCON>>,
}

impl PseudoConsole {
    fn close(&self) {
        if let Ok(mut handle) = self.handle.lock() {
            if let Some(hpc) = handle.take() {
                unsafe { ClosePseudoConsole(hpc) };
            }
        }
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        self.close();
    }
}

struct SessionCleanup {
    job: HANDLE,
    output: Option<OwnedHandle>,
    pseudoconsole: Arc<PseudoConsole>,
}

impl Drop for SessionCleanup {
    fn drop(&mut self) {
        // Early launch/token failures happen before the output reader exists. Close that read end
        // before ConPTY shutdown and stop the owned job before unwinding to its outer owner.
        // This is best-effort error cleanup, never a source of a successful completion frame.
        unsafe {
            TerminateJobObject(self.job, 137);
        }
        drop(self.output.take());
        self.pseudoconsole.close();
    }
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
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
        } else {
            if ch == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
            } else {
                out.push_str(&"\\".repeat(slashes));
            }
            out.push(ch);
            slashes = 0;
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn send_frame(writer: &Arc<Mutex<std::io::Stdout>>, kind: u8, payload: &[u8]) -> Result<()> {
    if payload.len() > u32::MAX as usize {
        return Err("native terminal frame is too large".to_string());
    }
    let mut output = writer
        .lock()
        .map_err(|_| "native terminal output lock is poisoned".to_string())?;
    output
        .write_all(&[kind])
        .map_err(|error| format!("write terminal frame type: {error}"))?;
    output
        .write_all(&(payload.len() as u32).to_be_bytes())
        .map_err(|error| format!("write terminal frame length: {error}"))?;
    output
        .write_all(payload)
        .map_err(|error| format!("write terminal frame payload: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("flush terminal frame: {error}"))
}

pub fn send_completion(exit_code: i32, execution_nonce: &str) -> Result<()> {
    let mut payload = exit_code.to_be_bytes().to_vec();
    payload.extend_from_slice(execution_nonce.as_bytes());
    send_frame(
        &Arc::new(Mutex::new(std::io::stdout())),
        FRAME_EXITED,
        &payload,
    )
}

fn write_pipe(handle: HANDLE, payload: &[u8]) -> Result<()> {
    let mut offset = 0;
    while offset < payload.len() {
        let mut written = 0;
        let chunk = (payload.len() - offset).min(u32::MAX as usize) as u32;
        let ok = unsafe {
            WriteFile(
                handle,
                payload[offset..].as_ptr(),
                chunk,
                &mut written,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!("WriteFile(ConPTY input) failed: {}", unsafe {
                GetLastError()
            }));
        }
        if written == 0 {
            return Err("WriteFile(ConPTY input) made no progress".to_string());
        }
        offset += written as usize;
    }
    Ok(())
}

unsafe fn assert_app_container_process(process: HANDLE) -> Result<()> {
    let mut token: HANDLE = null_mut();
    if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
        return Err(format!(
            "OpenProcessToken(child) failed: {}",
            GetLastError()
        ));
    }
    let token = OwnedHandle(token);
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
        return Err(format!(
            "GetTokenInformation(TokenIsAppContainer) failed: {}",
            GetLastError()
        ));
    }
    if isolated == 0 {
        return Err("child token is not AppContainer-isolated; execution denied".to_string());
    }
    Ok(())
}

pub unsafe fn run(
    token: HANDLE,
    cwd: &Path,
    command: &[String],
    desktop_name: *mut u16,
    app_container_sid: Option<PSID>,
    resource_limits: ResourceLimits,
    columns: i16,
    rows: i16,
    job: HANDLE,
) -> Result<i32> {
    if command.is_empty() {
        return Err("missing command".to_string());
    }

    let mut pty_input_read: HANDLE = null_mut();
    let mut input_write: HANDLE = null_mut();
    let mut output_read: HANDLE = null_mut();
    let mut pty_output_write: HANDLE = null_mut();
    if CreatePipe(&mut pty_input_read, &mut input_write, null(), 0) == 0 {
        return Err(format!("CreatePipe(ConPTY) failed: {}", GetLastError()));
    }
    let pty_input_read = OwnedHandle(pty_input_read);
    let input_write = OwnedHandle(input_write);
    if CreatePipe(&mut output_read, &mut pty_output_write, null(), 0) == 0 {
        return Err(format!("CreatePipe(ConPTY) failed: {}", GetLastError()));
    }
    let output_read = OwnedHandle(output_read);
    let pty_output_write = OwnedHandle(pty_output_write);
    let mut pseudoconsole: HPCON = 0;
    let hr = CreatePseudoConsole(
        COORD {
            X: columns,
            Y: rows,
        },
        pty_input_read.0,
        pty_output_write.0,
        PSEUDOCONSOLE_RESIZE_QUIRK,
        &mut pseudoconsole,
    );
    if hr < 0 {
        return Err(format!("CreatePseudoConsole failed: HRESULT {hr}"));
    }
    let pseudoconsole = Arc::new(PseudoConsole {
        handle: Mutex::new(Some(pseudoconsole)),
    });
    // ConPTY owns duplicates. Keeping our output write handle open prevents reader EOF forever.
    drop(pty_input_read);
    drop(pty_output_write);
    let mut session_cleanup = SessionCleanup {
        job,
        output: Some(output_read),
        pseudoconsole: Arc::clone(&pseudoconsole),
    };

    let hpc = pseudoconsole
        .handle
        .lock()
        .map_err(|_| "ConPTY handle lock is poisoned".to_string())?
        .ok_or_else(|| "ConPTY handle is unavailable".to_string())?;
    let mut security_capabilities = app_container_sid.map(|sid| {
        Box::new(SECURITY_CAPABILITIES {
            AppContainerSid: sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        })
    });
    let mut attrs = AttributeList::new(hpc, job, security_capabilities.as_deref_mut())?;
    let command_line = command
        .iter()
        .map(|arg| quote_arg(OsStr::new(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    let mut command_w = wide(command_line);
    let cwd_w = wide(cwd.as_os_str());
    let mut startup: STARTUPINFOEXW = std::mem::zeroed();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    startup.StartupInfo.lpDesktop = desktop_name;
    startup.lpAttributeList = attrs.as_mut_ptr();
    let mut process: PROCESS_INFORMATION = std::mem::zeroed();
    if CreateProcessAsUserW(
        token,
        null(),
        command_w.as_mut_ptr(),
        null(),
        null(),
        1,
        EXTENDED_STARTUPINFO_PRESENT,
        null(),
        cwd_w.as_ptr(),
        &startup.StartupInfo,
        &mut process,
    ) == 0
    {
        return Err(format!(
            "CreateProcessAsUserW(ConPTY) failed: {}",
            GetLastError()
        ));
    }
    let process_handle = OwnedHandle(process.hProcess);
    let _thread_handle = OwnedHandle(process.hThread);
    if app_container_sid.is_some() {
        assert_app_container_process(process_handle.0)?;
    }
    drop(attrs);

    let writer = Arc::new(Mutex::new(std::io::stdout()));
    send_frame(&writer, FRAME_STARTED, &process.dwProcessId.to_be_bytes())?;
    let monitor = ResourceMonitor::start(job, resource_limits);

    let output_writer = Arc::clone(&writer);
    let output_read = session_cleanup
        .output
        .take()
        .ok_or_else(|| "ConPTY output handle is unavailable".to_string())?;
    let output_thread = thread::spawn(move || -> Result<()> {
        let _output_read = output_read;
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            let mut read = 0;
            let ok = unsafe {
                ReadFile(
                    _output_read.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    null_mut(),
                )
            };
            if ok == 0 {
                let error = unsafe { GetLastError() };
                if error != ERROR_BROKEN_PIPE {
                    return Err(format!("ReadFile(ConPTY output) failed: {error}"));
                }
                break;
            }
            if read == 0 {
                break;
            }
            send_frame(&output_writer, FRAME_OUTPUT, &buffer[..read as usize])?;
        }
        Ok(())
    });

    let controller_pty = Arc::clone(&pseudoconsole);
    let controller_writer = Arc::clone(&writer);
    // Clear the shared handle before returning, so a delayed control frame cannot use a reused handle.
    let controller_activity = Arc::new(Mutex::new(Some(job as usize)));
    let input_activity = Arc::clone(&controller_activity);
    thread::spawn(move || {
        let mut input_write = Some(input_write);
        let mut stdin = std::io::stdin();
        loop {
            let mut header = [0u8; 5];
            if stdin.read_exact(&mut header).is_err() {
                if let Ok(guard) = input_activity.lock() {
                    if let Some(job_handle) = *guard {
                        unsafe {
                            TerminateJobObject(job_handle as HANDLE, 137);
                        }
                    }
                }
                break;
            }
            let length = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
            if length > MAX_FRAME_BYTES {
                let _ = send_frame(
                    &controller_writer,
                    FRAME_ERROR,
                    b"native terminal input frame exceeds limit",
                );
                break;
            }
            let mut payload = vec![0u8; length];
            if stdin.read_exact(&mut payload).is_err() {
                break;
            }
            if payload.len() < 4 {
                let _ = send_frame(
                    &controller_writer,
                    FRAME_ERROR,
                    b"native terminal control frame is missing its operation id",
                );
                break;
            }
            let operation_id = &payload[..4];
            let body = &payload[4..];
            let _activity = match input_activity.lock() {
                Ok(value) => value,
                Err(_) => break,
            };
            let Some(job_handle) = *_activity else {
                break;
            };
            let result = match header[0] {
                FRAME_INPUT => match input_write.as_ref() {
                    Some(pipe) => write_pipe(pipe.0, body),
                    None => Err("ConPTY input is already closed".to_string()),
                },
                FRAME_RESIZE if body.len() == 4 => {
                    let columns = u16::from_be_bytes([body[0], body[1]]) as i16;
                    let rows = u16::from_be_bytes([body[2], body[3]]) as i16;
                    if columns < 1 || rows < 1 {
                        Err("terminal dimensions must be positive".to_string())
                    } else {
                        let guard = controller_pty
                            .handle
                            .lock()
                            .map_err(|_| "ConPTY handle lock is poisoned".to_string());
                        guard
                            .and_then(|value| {
                                value.ok_or_else(|| "ConPTY has already closed".to_string())
                            })
                            .and_then(|hpc| {
                                let hr = unsafe {
                                    ResizePseudoConsole(
                                        hpc,
                                        COORD {
                                            X: columns,
                                            Y: rows,
                                        },
                                    )
                                };
                                if hr < 0 {
                                    Err(format!("ResizePseudoConsole failed: HRESULT {hr}"))
                                } else {
                                    Ok(())
                                }
                            })
                    }
                }
                FRAME_CLOSE_INPUT if body.is_empty() => {
                    // EOF closes only target input, not the helper's resize/termination channel.
                    drop(input_write.take());
                    Ok(())
                }
                FRAME_TERMINATE if body.len() == 1 => {
                    let code = if body[0] == 0 { 143 } else { 137 };
                    if unsafe { TerminateJobObject(job_handle as HANDLE, code) } == 0 {
                        Err(format!("TerminateJobObject failed: {}", unsafe {
                            GetLastError()
                        }))
                    } else {
                        Ok(())
                    }
                }
                _ => Err("unsupported native terminal control frame".to_string()),
            };
            let mut acknowledgment = Vec::with_capacity(5);
            acknowledgment.extend_from_slice(operation_id);
            match result {
                Ok(()) => acknowledgment.push(0),
                Err(error) => {
                    acknowledgment.push(1);
                    acknowledgment.extend_from_slice(error.as_bytes());
                }
            }
            let _ = send_frame(&controller_writer, FRAME_ACK, &acknowledgment);
        }
    });

    let waited = WaitForSingleObject(process_handle.0, INFINITE);
    // Kill remaining job members before waiting for the controller lock or draining ConPTY.
    // A descendant can otherwise hold the input/output pipes and block those operations forever.
    let tree_cleanup = terminate_and_wait(job);
    let mut activity = controller_activity
        .lock()
        .map_err(|_| "terminal controller lock is poisoned".to_string())?;
    *activity = None;
    drop(activity);
    tree_cleanup?;
    if waited != WAIT_OBJECT_0 {
        return Err(format!(
            "WaitForSingleObject(ConPTY child) failed: {}",
            GetLastError()
        ));
    }
    let mut exit_code = 1u32;
    if GetExitCodeProcess(process_handle.0, &mut exit_code) == 0 {
        return Err(format!("GetExitCodeProcess failed: {}", GetLastError()));
    }
    if let Some(resource) = monitor.finish()? {
        send_frame(&writer, FRAME_RESOURCE_LIMIT, resource.as_str().as_bytes())?;
    }
    pseudoconsole.close();
    output_thread
        .join()
        .map_err(|_| "ConPTY output reader panicked".to_string())??;
    Ok(exit_code as i32)
}
