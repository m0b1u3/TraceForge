use crate::cleanup::supervise;
use crate::config::{Grant, PtyRunConfig, Result, RunConfig, Scope};
use std::ffi::{CString, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::ptr;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CLONE_INTO_CGROUP: u64 = 0x200000000;
const CLONE_PIDFD: u64 = 0x00001000;
const MOUNT_ATTR_RDONLY: u64 = 0x00000001;
const MOUNT_ATTR_NOSUID: u64 = 0x00000002;
const MOUNT_ATTR_NODEV: u64 = 0x00000004;
const MOUNT_ATTR_NOEXEC: u64 = 0x00000008;
const AT_RECURSIVE: u32 = 0x8000;
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

#[repr(C)]
#[derive(Default)]
struct CloneArgs {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}
#[repr(C)]
struct MountAttr {
    attr_set: u64,
    attr_clr: u64,
    propagation: u64,
    userns_fd: u64,
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Default)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

fn context<T, E: std::fmt::Display>(value: std::result::Result<T, E>, message: &str) -> Result<T> {
    value.map_err(|error| format!("{message}: {error}"))
}
fn write_control(path: impl AsRef<Path>, value: impl AsRef<[u8]>) -> Result<()> {
    context(fs::write(path, value), "cgroup control write failed")
}
fn read_number(path: impl AsRef<Path>) -> Result<u64> {
    let value = context(fs::read_to_string(path), "cgroup counter read failed")?;
    value
        .trim()
        .parse()
        .map_err(|_| "cgroup counter is invalid".into())
}
fn unique(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        unsafe { libc::getpid() },
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

struct OwnedTree {
    path: PathBuf,
}
struct OwnedFilePath {
    path: PathBuf,
}
impl Drop for OwnedFilePath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
impl Drop for OwnedTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
struct OwnedCgroup {
    path: PathBuf,
}
impl OwnedCgroup {
    fn kill(&self) -> Result<()> {
        write_control(self.path.join("cgroup.kill"), b"1")
    }
}
impl Drop for OwnedCgroup {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn private_directory(path: &Path) -> Result<()> {
    if !path.exists() {
        context(
            fs::create_dir_all(path),
            "scratch directory creation failed",
        )?;
        context(
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)),
            "scratch permissions failed",
        )?;
    }
    let meta = context(fs::symlink_metadata(path), "scratch metadata failed")?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.permissions().mode() & 0o077 != 0
    {
        return Err("scratch root must be a private directory owned by the helper user".into());
    }
    Ok(())
}

fn cgroup(root: &Path, run_id: &str, limits: &crate::config::Limits) -> Result<OwnedCgroup> {
    let root = context(fs::canonicalize(root), "cgroup root is unavailable")?;
    if !root.join("cgroup.controllers").is_file() || !root.join("cgroup.procs").is_file() {
        return Err("cgroup root is not a delegated cgroup v2 directory".into());
    }
    let path = root.join(format!("traceforge-{run_id}"));
    context(fs::create_dir(&path), "delegated cgroup creation failed")?;
    let owned = OwnedCgroup { path };
    write_control(
        owned.path.join("memory.max"),
        limits.memory_bytes.to_string(),
    )?;
    write_control(owned.path.join("memory.oom.group"), b"1")?;
    write_control(owned.path.join("pids.max"), limits.processes.to_string())?;
    // Rate limiting complements the total CPU accounting enforced by the supervisor.
    write_control(owned.path.join("cpu.max"), b"100000 100000")?;
    if !owned.path.join("cgroup.kill").is_file() {
        return Err("delegated cgroup does not provide cgroup.kill".into());
    }
    Ok(owned)
}

fn cstring(value: &OsStr, name: &str) -> Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| format!("{name} contains NUL"))
}
fn write_map(pid: i32, name: &str, value: String) -> Result<()> {
    context(
        fs::write(format!("/proc/{pid}/{name}"), value),
        "user namespace identity mapping failed",
    )
}

unsafe fn clone_into(cgroup_fd: i32, sync_read: i32, pidfd: &mut i32) -> Result<i32> {
    let flags = CLONE_INTO_CGROUP
        | CLONE_PIDFD
        | libc::CLONE_NEWUSER as u64
        | libc::CLONE_NEWNS as u64
        | libc::CLONE_NEWPID as u64
        | libc::CLONE_NEWIPC as u64
        | libc::CLONE_NEWUTS as u64
        | libc::CLONE_NEWNET as u64;
    let mut args = CloneArgs {
        flags,
        pidfd: pidfd as *mut i32 as u64,
        exit_signal: libc::SIGCHLD as u64,
        cgroup: cgroup_fd as u64,
        ..Default::default()
    };
    let result = libc::syscall(
        libc::SYS_clone3,
        &mut args,
        std::mem::size_of::<CloneArgs>(),
    );
    if result < 0 {
        return Err(format!(
            "clone3 namespace/cgroup creation failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if result == 0 {
        child_wait(sync_read);
    }
    Ok(result as i32)
}

unsafe fn child_wait(sync_read: i32) {
    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
        libc::_exit(125)
    }
    // The namespace init cannot observe its parent outside CLONE_NEWPID:
    // getppid() is 0 even while the helper is alive. The synchronization pipe
    // closes on helper death and therefore covers the pre-PDEATHSIG race.
    let mut byte = 0u8;
    if libc::read(sync_read, &mut byte as *mut u8 as *mut _, 1) != 1 {
        libc::_exit(125)
    }
}

fn mount_call(
    source: Option<&CString>,
    target: &CString,
    fstype: Option<&CString>,
    flags: libc::c_ulong,
    data: Option<&CString>,
) -> Result<()> {
    let rc = unsafe {
        libc::mount(
            source.map_or(ptr::null(), |v| v.as_ptr()),
            target.as_ptr(),
            fstype.map_or(ptr::null(), |v| v.as_ptr()),
            flags,
            data.map_or(ptr::null(), |v| v.as_ptr().cast()),
        )
    };
    if rc != 0 {
        Err(format!(
            "mount failed for {}: {}",
            target.to_string_lossy(),
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}
fn mount_attrs(target: &Path, readonly: bool, noexec: bool) -> Result<()> {
    let target = cstring(target.as_os_str(), "mount target")?;
    let mut set = MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV;
    if readonly {
        set |= MOUNT_ATTR_RDONLY
    }
    if noexec {
        set |= MOUNT_ATTR_NOEXEC
    }
    let attrs = MountAttr {
        attr_set: set,
        attr_clr: 0,
        propagation: 0,
        userns_fd: 0,
    };
    let rc = unsafe {
        libc::syscall(
            libc::SYS_mount_setattr,
            libc::AT_FDCWD,
            target.as_ptr(),
            AT_RECURSIVE,
            &attrs,
            std::mem::size_of::<MountAttr>(),
        )
    };
    if rc != 0 {
        Err(format!(
            "recursive mount policy failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn destination(root: &Path, path: &Path, is_dir: bool) -> Result<PathBuf> {
    let relative = path
        .strip_prefix("/")
        .map_err(|_| "mount path is not absolute")?;
    let dest = root.join(relative);
    if dest.exists() {
        let existing = context(fs::metadata(&dest), "existing mount target metadata failed")?;
        if existing.is_dir() != is_dir {
            return Err("mount target type conflicts with an earlier policy grant".into());
        }
    } else if is_dir {
        context(fs::create_dir_all(&dest), "mount directory creation failed")?;
    } else {
        if let Some(parent) = dest.parent() {
            context(fs::create_dir_all(parent), "mount parent creation failed")?;
        }
        context(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&dest),
            "mount placeholder creation failed",
        )?;
    }
    Ok(dest)
}
fn bind(root: &Path, grant: &Grant, readonly: bool) -> Result<()> {
    let canonical = context(
        fs::canonicalize(&grant.path),
        "policy path canonicalization failed",
    )?;
    if canonical != grant.path {
        return Err(format!(
            "policy path is not canonical: {}",
            grant.path.display()
        ));
    }
    let meta = context(fs::metadata(&canonical), "policy path metadata failed")?;
    if meta.is_dir() && grant.scope == Scope::Exact {
        return Err("exact directory grants cannot prove child isolation".into());
    }
    let source_file = context(
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&canonical),
        "policy path open failed",
    )?;
    let source = cstring(
        OsStr::new(&format!("/proc/self/fd/{}", source_file.as_raw_fd())),
        "bind source",
    )?;
    let dest = destination(root, &canonical, meta.is_dir())?;
    let target = cstring(dest.as_os_str(), "bind target")?;
    mount_call(
        Some(&source),
        &target,
        None,
        libc::MS_BIND
            | if grant.scope == Scope::Tree {
                libc::MS_REC
            } else {
                0
            },
        None,
    )?;
    mount_attrs(&dest, readonly, !readonly)?;
    Ok(())
}
fn mask(root: &Path, grant: &Grant) -> Result<()> {
    let meta = context(fs::metadata(&grant.path), "deny path metadata failed")?;
    let dest = destination(root, &grant.path, meta.is_dir())?;
    if meta.is_dir() {
        let source = CString::new("tmpfs").unwrap();
        let target = cstring(dest.as_os_str(), "deny target")?;
        let data = CString::new("size=4096,mode=000").unwrap();
        mount_call(
            Some(&source),
            &target,
            Some(&source),
            libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
            Some(&data),
        )?;
    } else {
        let source = CString::new("/dev/null").unwrap();
        let target = cstring(dest.as_os_str(), "deny target")?;
        mount_call(Some(&source), &target, None, libc::MS_BIND, None)?;
    }
    mount_attrs(&dest, true, true)
}

fn contains(grant: &Grant, path: &Path) -> bool {
    grant.path == path || (grant.scope == Scope::Tree && path.starts_with(&grant.path))
}

fn install_runtime_aliases(root: &Path) -> Result<()> {
    for name in ["bin", "sbin", "lib", "lib64"] {
        let host_path = Path::new("/").join(name);
        let Ok(metadata) = fs::symlink_metadata(&host_path) else {
            continue;
        };
        if !metadata.file_type().is_symlink() {
            continue;
        }
        let target = context(fs::read_link(&host_path), "runtime alias read failed")?;
        if target.is_absolute()
            || target
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(format!(
                "runtime alias {name} has an unsafe target: {}",
                target.display()
            ));
        }
        context(
            symlink(&target, root.join(name)),
            "runtime alias creation failed",
        )?;
    }
    Ok(())
}

fn filesystem(config: &RunConfig, root: &Path) -> Result<()> {
    if !config
        .read
        .iter()
        .chain(&config.write)
        .any(|g| contains(g, &config.executable))
    {
        return Err("executable is outside the granted filesystem profile".into());
    }
    if config.cwd != Path::new("/")
        && !config
            .read
            .iter()
            .chain(&config.write)
            .any(|g| contains(g, &config.cwd))
    {
        return Err("working directory is outside the granted filesystem profile".into());
    }
    unsafe {
        if libc::mount(
            ptr::null(),
            CString::new("/").unwrap().as_ptr(),
            ptr::null(),
            libc::MS_REC | libc::MS_PRIVATE,
            ptr::null(),
        ) != 0
        {
            return Err(format!(
                "private mount propagation failed: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    let tmpfs = CString::new("tmpfs").unwrap();
    let root_c = cstring(root.as_os_str(), "sandbox root")?;
    let data = CString::new("size=64m,mode=0755").unwrap();
    mount_call(
        Some(&tmpfs),
        &root_c,
        Some(&tmpfs),
        libc::MS_NOSUID | libc::MS_NODEV,
        Some(&data),
    )?;
    install_runtime_aliases(root)?;
    for grant in &config.read {
        bind(root, grant, true)?;
    }
    for grant in &config.write {
        bind(root, grant, false)?;
    }
    for grant in &config.deny {
        mask(root, grant)?;
    }
    let proc_path = root.join("proc");
    fs::create_dir_all(&proc_path).map_err(|e| e.to_string())?;
    let proc_c = cstring(proc_path.as_os_str(), "proc target")?;
    let procfs = CString::new("proc").unwrap();
    mount_call(
        Some(&procfs),
        &proc_c,
        Some(&procfs),
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        None,
    )?;
    let old = root.join(".old-root");
    fs::create_dir(&old).map_err(|e| format!("old root creation failed: {e}"))?;
    let old_c = cstring(old.as_os_str(), "old root")?;
    let rc = unsafe { libc::syscall(libc::SYS_pivot_root, root_c.as_ptr(), old_c.as_ptr()) };
    if rc != 0 {
        return Err(format!(
            "pivot_root failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let slash = CString::new("/").unwrap();
    unsafe {
        if libc::chdir(slash.as_ptr()) != 0 {
            return Err("sandbox chdir failed".into());
        }
        let old = CString::new("/.old-root").unwrap();
        if libc::umount2(old.as_ptr(), libc::MNT_DETACH) != 0 {
            return Err("old root detach failed".into());
        }
        libc::rmdir(old.as_ptr());
    }
    Ok(())
}

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xc000003e;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xc00000b7;
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("traceforge-linux-sandbox supports only x86_64 and aarch64 Linux");
fn seccomp() -> Result<()> {
    let denied = [
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_setns,
        libc::SYS_unshare,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_perf_event_open,
        libc::SYS_kexec_load,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_open_by_handle_at,
        libc::SYS_userfaultfd,
        libc::SYS_io_uring_setup,
        libc::SYS_mount_setattr,
        libc::SYS_move_mount,
        libc::SYS_open_tree,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_chroot,
    ];
    let stmt = |code, k| libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    };
    let jump = |k, jt, jf| libc::sock_filter {
        code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
        jt,
        jf,
        k,
    };
    let mut filter = vec![
        stmt((libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16, 4),
        jump(AUDIT_ARCH, 1, 0),
        stmt(
            (libc::BPF_RET | libc::BPF_K) as u16,
            libc::SECCOMP_RET_KILL_PROCESS,
        ),
        stmt((libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16, 0),
    ];
    for syscall in denied {
        filter.push(jump(syscall as u32, 0, 1));
        filter.push(stmt(
            (libc::BPF_RET | libc::BPF_K) as u16,
            libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
        ));
    }
    // The target must not clear the helper-death kill signal. Other harmless prctl
    // operations remain available to language runtimes (for example thread names).
    filter.push(jump(libc::SYS_prctl as u32, 0, 3));
    filter.push(stmt(
        (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
        16,
    ));
    filter.push(jump(libc::PR_SET_PDEATHSIG as u32, 0, 1));
    filter.push(stmt(
        (libc::BPF_RET | libc::BPF_K) as u16,
        libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
    ));
    filter.push(stmt(
        (libc::BPF_RET | libc::BPF_K) as u16,
        libc::SECCOMP_RET_ALLOW,
    ));
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err("PR_SET_NO_NEW_PRIVS failed".into());
        }
        if libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) != 0 {
            return Err(format!(
                "seccomp installation failed: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

fn drop_capabilities() -> Result<()> {
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x20080522;
    const SECBIT_NOROOT: libc::c_ulong = 1;
    const SECBIT_NOROOT_LOCKED: libc::c_ulong = 2;
    const SECBIT_NO_SETUID_FIXUP: libc::c_ulong = 4;
    const SECBIT_NO_SETUID_FIXUP_LOCKED: libc::c_ulong = 8;
    unsafe {
        if libc::prctl(
            libc::PR_SET_SECUREBITS,
            SECBIT_NOROOT
                | SECBIT_NOROOT_LOCKED
                | SECBIT_NO_SETUID_FIXUP
                | SECBIT_NO_SETUID_FIXUP_LOCKED,
            0,
            0,
            0,
        ) != 0
        {
            return Err("securebits lockdown failed".into());
        }
        for capability in 0..64 {
            let _ = libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0);
        }
        let mut header = CapabilityHeader {
            version: LINUX_CAPABILITY_VERSION_3,
            pid: 0,
        };
        let mut data = [CapabilityData::default(), CapabilityData::default()];
        if libc::syscall(libc::SYS_capset, &mut header, data.as_mut_ptr()) != 0 {
            return Err(format!(
                "capability drop failed: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

fn exec_target(config: &RunConfig, root: &Path) -> Result<()> {
    filesystem(config, root)?;
    context(
        std::env::set_current_dir(&config.cwd),
        "sandbox working directory failed",
    )?;
    drop_capabilities()?;
    seccomp()?;
    let executable = cstring(config.executable.as_os_str(), "executable")?;
    let mut argv = Vec::with_capacity(config.arguments.len() + 1);
    argv.push(executable.clone());
    for value in &config.arguments {
        argv.push(CString::new(value.as_bytes()).map_err(|_| "argument contains NUL")?);
    }
    let mut argv_ptr = argv.iter().map(|v| v.as_ptr()).collect::<Vec<_>>();
    argv_ptr.push(ptr::null());
    let env = std::env::vars_os()
        .filter_map(|(key, value)| {
            key.to_str()
                .and_then(|name| name.strip_prefix("TRACEFORGE_TARGET_ENV_"))
                .map(|encoded| (encoded.to_string(), value))
        })
        .map(|(encoded_key, encoded_value)| {
            let key = decode_hex(encoded_key.as_bytes())?;
            let value = decode_hex(encoded_value.as_bytes())?;
            if key.is_empty() || key.contains(&b'=') {
                return Err("target environment key is invalid".into());
            }
            let mut bytes = key;
            bytes.push(b'=');
            bytes.extend(value);
            CString::new(bytes).map_err(|_| "target environment contains NUL".to_string())
        })
        .collect::<Result<Vec<_>>>()?;
    let mut env_ptr = env.iter().map(|v| v.as_ptr()).collect::<Vec<_>>();
    env_ptr.push(ptr::null());
    unsafe {
        libc::execve(executable.as_ptr(), argv_ptr.as_ptr(), env_ptr.as_ptr());
    }
    Err(format!(
        "execve failed: {}",
        std::io::Error::last_os_error()
    ))
}

fn decode_hex(value: &[u8]) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 {
        return Err("target environment encoding is invalid".into());
    }
    value
        .chunks_exact(2)
        .map(|pair| {
            let digit = |value: u8| match value {
                b'0'..=b'9' => Some(value - b'0'),
                b'a'..=b'f' => Some(value - b'a' + 10),
                b'A'..=b'F' => Some(value - b'A' + 10),
                _ => None,
            };
            Ok(digit(pair[0])
                .ok_or_else(|| "target environment encoding is invalid".to_string())?
                * 16
                + digit(pair[1])
                    .ok_or_else(|| "target environment encoding is invalid".to_string())?)
        })
        .collect()
}

fn parse_field(text: &str, name: &str) -> u64 {
    text.lines()
        .filter_map(|line| line.split_once(' '))
        .find_map(|(key, value)| (key == name).then(|| value.parse().ok()).flatten())
        .unwrap_or(0)
}
fn field(path: &Path, name: &str) -> Result<u64> {
    let text = context(fs::read_to_string(path), "cgroup event read failed")?;
    Ok(parse_field(&text, name))
}
fn io_writes(path: &Path) -> Result<u64> {
    let text = context(fs::read_to_string(path), "cgroup io accounting read failed")?;
    Ok(text
        .split_whitespace()
        .filter_map(|item| {
            item.strip_prefix("wbytes=")
                .and_then(|v| v.parse::<u64>().ok())
        })
        .sum())
}
fn wait_status(pid: i32) -> Result<Option<i32>> {
    let mut status = 0;
    let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if result < 0 {
        return Err(format!(
            "waitpid failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if result == 0 {
        return Ok(None);
    };
    let code = if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        125
    };
    Ok(Some(code))
}

pub fn run(config: RunConfig) -> Result<i32> {
    let parent = unsafe { libc::getppid() };
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } != 0 {
        return Err(format!(
            "helper parent-death signal failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { libc::getppid() } != parent {
        return Err("execution host exited while the helper was starting".into());
    }
    private_directory(&config.scratch_root)?;
    let run_id = unique("execution");
    let run_root = config.scratch_root.join(format!("run-{run_id}"));
    context(fs::create_dir(&run_root), "sandbox run directory failed")?;
    let tree = OwnedTree {
        path: run_root.clone(),
    };
    let root = tree.path.join("root");
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    let group = cgroup(&config.cgroup_root, &run_id, &config.limits)?;
    let group_fd = context(
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(&group.path),
        "cgroup open failed",
    )?;
    let mut pipes = [0; 2];
    if unsafe { libc::pipe2(pipes.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err("namespace synchronization pipe failed".into());
    }
    let read_fd = unsafe { OwnedFd::from_raw_fd(pipes[0]) };
    let write_fd = unsafe { OwnedFd::from_raw_fd(pipes[1]) };
    let mut pidfd = -1;
    let mut status_file = context(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&config.status_file),
        "resource status file creation failed",
    )?;
    // Capture event baselines before the child can consume any resource. A
    // short-lived target may hit OOM or pids.max before the parent returns
    // from clone3/setup; sampling afterward would erase that event delta.
    let oom0 = field(&group.path.join("memory.events"), "oom_kill")?;
    let pids0 = field(&group.path.join("pids.events"), "max")?;
    let pid = unsafe { clone_into(group_fd.as_raw_fd(), read_fd.as_raw_fd(), &mut pidfd)? };
    if pid == 0 {
        drop(write_fd);
        if let Err(error) = exec_target(&config, &root) {
            eprintln!("traceforge-linux-sandbox child: {error}");
            unsafe { libc::_exit(125) }
        }
        unsafe { libc::_exit(125) }
    }
    drop(read_fd);
    let setup = (|| {
        write_map(pid, "setgroups", "deny".into())?;
        write_map(
            pid,
            "uid_map",
            format!("0 {} 1", unsafe { libc::geteuid() }),
        )?;
        write_map(
            pid,
            "gid_map",
            format!("0 {} 1", unsafe { libc::getegid() }),
        )?;
        context(
            (&File::from(write_fd)).write_all(&[1]),
            "namespace release failed",
        )
    })();
    if let Err(error) = setup {
        let _ = group.kill();
        unsafe {
            libc::waitpid(pid, ptr::null_mut(), 0);
        }
        return Err(error);
    }
    if pidfd < 0 {
        let _ = group.kill();
        unsafe {
            libc::waitpid(pid, ptr::null_mut(), 0);
        }
        return Err("clone3 did not return the required pidfd".into());
    }
    let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd) };
    let cleanup_started = std::cell::Cell::new(None::<Instant>);
    let result = supervise(
        || {
            Ok((
                field(&group.path.join("cpu.stat"), "usage_usec")?,
                io_writes(&group.path.join("io.stat"))?,
                read_number(group.path.join("pids.current"))?,
                field(&group.path.join("memory.events"), "oom_kill")? > oom0,
                field(&group.path.join("pids.events"), "max")? > pids0,
            ))
        },
        || wait_status(pid),
        || group.kill(),
        |cleaning| {
            if cleaning && cleanup_started.get().is_none() {
                cleanup_started.set(Some(Instant::now()));
            }
            std::thread::sleep(Duration::from_millis(20));
            cleanup_started
                .get()
                .map_or(true, |started| started.elapsed() < Duration::from_secs(5))
        },
        config.limits.cpu_time_ms * 1000,
        config.limits.write_bytes,
    )?;
    if let Some(reason) = result.1 {
        context(
            status_file.write_all(reason.as_bytes()),
            "resource status write failed",
        )?;
        context(status_file.sync_all(), "resource status sync failed")?;
    }
    drop(status_file);
    drop(pidfd);
    drop(group_fd);
    drop(tree);
    drop(group);
    Ok(result.0)
}

type TerminalWriter = Arc<Mutex<std::io::Stdout>>;

fn terminal_frame(writer: &TerminalWriter, kind: u8, payload: &[u8]) -> Result<()> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err("native terminal output frame exceeds limit".into());
    }
    let mut output = writer
        .lock()
        .map_err(|_| "native terminal output lock is poisoned".to_string())?;
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    context(
        output.write_all(&header),
        "native terminal frame header write failed",
    )?;
    context(
        output.write_all(payload),
        "native terminal frame body write failed",
    )?;
    context(output.flush(), "native terminal frame flush failed")
}

fn terminal_ack(writer: &TerminalWriter, operation: &[u8], result: Result<()>) -> Result<()> {
    let mut payload = Vec::with_capacity(5);
    payload.extend_from_slice(operation);
    match result {
        Ok(()) => payload.push(0),
        Err(error) => {
            payload.push(1);
            payload.extend_from_slice(error.as_bytes());
        }
    }
    terminal_frame(writer, FRAME_ACK, &payload)
}

fn set_cloexec(fd: i32) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0 {
        return Err(format!(
            "terminal descriptor protection failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn terminal_size(fd: i32, columns: u16, rows: u16) -> Result<()> {
    if columns == 0 || rows == 0 {
        return Err("terminal dimensions must be positive".into());
    }
    let size = libc::winsize {
        ws_row: rows,
        ws_col: columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) } != 0 {
        return Err(format!(
            "terminal resize failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/** Framed PTY mode; isolation, resource accounting and empty-tree completion are identical to stdio run. */
pub fn pty_run(terminal: PtyRunConfig) -> Result<i32> {
    let config = terminal.run;
    let parent = unsafe { libc::getppid() };
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } != 0 {
        return Err(format!(
            "helper parent-death signal failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { libc::getppid() } != parent {
        return Err("execution host exited while the helper was starting".into());
    }
    private_directory(&config.scratch_root)?;
    let run_id = unique("execution");
    let run_root = config.scratch_root.join(format!("run-{run_id}"));
    context(fs::create_dir(&run_root), "sandbox run directory failed")?;
    let tree = OwnedTree {
        path: run_root.clone(),
    };
    let root = tree.path.join("root");
    context(fs::create_dir(&root), "sandbox root creation failed")?;
    let group = cgroup(&config.cgroup_root, &run_id, &config.limits)?;
    let group_fd = context(
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(&group.path),
        "cgroup open failed",
    )?;

    let mut master = -1;
    let mut slave = -1;
    let initial_size = libc::winsize {
        ws_row: terminal.rows,
        ws_col: terminal.columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            ptr::null_mut(),
            ptr::null(),
            &initial_size,
        )
    } != 0
    {
        return Err(format!(
            "terminal creation failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    set_cloexec(master)?;
    set_cloexec(slave)?;
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };

    let mut pipes = [0; 2];
    if unsafe { libc::pipe2(pipes.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err("namespace synchronization pipe failed".into());
    }
    let read_fd = unsafe { OwnedFd::from_raw_fd(pipes[0]) };
    let write_fd = unsafe { OwnedFd::from_raw_fd(pipes[1]) };
    let mut pidfd = -1;
    let mut status_file = context(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&config.status_file),
        "resource status file creation failed",
    )?;
    let oom0 = field(&group.path.join("memory.events"), "oom_kill")?;
    let pids0 = field(&group.path.join("pids.events"), "max")?;
    let pid = unsafe { clone_into(group_fd.as_raw_fd(), read_fd.as_raw_fd(), &mut pidfd)? };
    if pid == 0 {
        drop(write_fd);
        if unsafe { libc::setsid() } < 0
            || unsafe { libc::ioctl(slave.as_raw_fd(), libc::TIOCSCTTY, 0) } != 0
            || unsafe { libc::dup2(slave.as_raw_fd(), libc::STDIN_FILENO) } < 0
            || unsafe { libc::dup2(slave.as_raw_fd(), libc::STDOUT_FILENO) } < 0
            || unsafe { libc::dup2(slave.as_raw_fd(), libc::STDERR_FILENO) } < 0
        {
            unsafe { libc::_exit(125) }
        }
        drop(master);
        drop(slave);
        if let Err(error) = exec_target(&config, &root) {
            eprintln!("traceforge-linux-sandbox child: {error}");
            unsafe { libc::_exit(125) }
        }
        unsafe { libc::_exit(125) }
    }
    drop(slave);
    drop(read_fd);
    let setup = (|| {
        write_map(pid, "setgroups", "deny".into())?;
        write_map(
            pid,
            "uid_map",
            format!("0 {} 1", unsafe { libc::geteuid() }),
        )?;
        write_map(
            pid,
            "gid_map",
            format!("0 {} 1", unsafe { libc::getegid() }),
        )?;
        context(
            (&File::from(write_fd)).write_all(&[1]),
            "namespace release failed",
        )
    })();
    if let Err(error) = setup {
        let _ = group.kill();
        unsafe {
            libc::waitpid(pid, ptr::null_mut(), 0);
        }
        return Err(error);
    }
    if pidfd < 0 {
        let _ = group.kill();
        unsafe {
            libc::waitpid(pid, ptr::null_mut(), 0);
        }
        return Err("clone3 did not return the required pidfd".into());
    }
    let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd) };
    let read_master_fd = unsafe { libc::dup(master.as_raw_fd()) };
    if read_master_fd < 0 {
        let _ = group.kill();
        return Err("terminal output descriptor duplication failed".into());
    }
    set_cloexec(read_master_fd)?;
    let read_master = unsafe { OwnedFd::from_raw_fd(read_master_fd) };
    let writer: TerminalWriter = Arc::new(Mutex::new(std::io::stdout()));
    terminal_frame(&writer, FRAME_STARTED, &(pid as u32).to_be_bytes())?;

    let output_writer = Arc::clone(&writer);
    let output_thread = thread::spawn(move || -> Result<()> {
        let mut input = File::from(read_master);
        let mut bytes = [0u8; 8192];
        loop {
            match input.read(&mut bytes) {
                Ok(0) => return Ok(()),
                Ok(count) => terminal_frame(&output_writer, FRAME_OUTPUT, &bytes[..count])?,
                Err(error) if error.raw_os_error() == Some(libc::EIO) => return Ok(()),
                Err(error) => return Err(format!("terminal output read failed: {error}")),
            }
        }
    });

    let activity = Arc::new(Mutex::new(true));
    let control_activity = Arc::clone(&activity);
    let control_writer = Arc::clone(&writer);
    let control_group = group.path.clone();
    thread::spawn(move || {
        let mut controller = std::io::stdin();
        let mut terminal = File::from(master);
        loop {
            let mut header = [0u8; 5];
            if controller.read_exact(&mut header).is_err() {
                let _ = fs::write(control_group.join("cgroup.kill"), b"1");
                break;
            }
            let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
            if length > MAX_FRAME_BYTES {
                let _ = terminal_frame(
                    &control_writer,
                    FRAME_ERROR,
                    b"native terminal input frame exceeds limit",
                );
                let _ = fs::write(control_group.join("cgroup.kill"), b"1");
                break;
            }
            let mut payload = vec![0u8; length];
            if controller.read_exact(&mut payload).is_err() || payload.len() < 4 {
                let _ = fs::write(control_group.join("cgroup.kill"), b"1");
                break;
            }
            let operation = payload[..4].to_vec();
            let body = &payload[4..];
            let guard = match control_activity.lock() {
                Ok(value) => value,
                Err(_) => break,
            };
            if !*guard {
                break;
            }
            let result = match header[0] {
                FRAME_INPUT => context(terminal.write_all(body), "terminal input write failed"),
                FRAME_RESIZE if body.len() == 4 => terminal_size(
                    terminal.as_raw_fd(),
                    u16::from_be_bytes([body[0], body[1]]),
                    u16::from_be_bytes([body[2], body[3]]),
                ),
                FRAME_CLOSE_INPUT if body.is_empty() => {
                    context(terminal.write_all(&[0x04]), "terminal EOF write failed")
                }
                FRAME_TERMINATE if body.len() == 1 => context(
                    fs::write(control_group.join("cgroup.kill"), b"1"),
                    "terminal process-tree termination failed",
                ),
                _ => Err("unsupported native terminal control frame".into()),
            };
            let _ = terminal_ack(&control_writer, &operation, result);
        }
    });

    let cleanup_started = std::cell::Cell::new(None::<Instant>);
    let result = supervise(
        || {
            Ok((
                field(&group.path.join("cpu.stat"), "usage_usec")?,
                io_writes(&group.path.join("io.stat"))?,
                read_number(group.path.join("pids.current"))?,
                field(&group.path.join("memory.events"), "oom_kill")? > oom0,
                field(&group.path.join("pids.events"), "max")? > pids0,
            ))
        },
        || wait_status(pid),
        || group.kill(),
        |cleaning| {
            if cleaning && cleanup_started.get().is_none() {
                cleanup_started.set(Some(Instant::now()));
            }
            thread::sleep(Duration::from_millis(20));
            cleanup_started
                .get()
                .map_or(true, |started| started.elapsed() < Duration::from_secs(5))
        },
        config.limits.cpu_time_ms * 1000,
        config.limits.write_bytes,
    )?;
    {
        let mut active = activity
            .lock()
            .map_err(|_| "terminal controller lock is poisoned".to_string())?;
        *active = false;
    }
    if let Some(reason) = result.1 {
        context(
            status_file.write_all(reason.as_bytes()),
            "resource status write failed",
        )?;
        context(status_file.sync_all(), "resource status sync failed")?;
        terminal_frame(&writer, FRAME_RESOURCE_LIMIT, reason.as_bytes())?;
    }
    output_thread
        .join()
        .map_err(|_| "terminal output reader panicked".to_string())??;
    let mut completion = Vec::with_capacity(68);
    completion.extend_from_slice(&result.0.to_be_bytes());
    completion.extend_from_slice(terminal.execution_nonce.as_bytes());
    terminal_frame(&writer, FRAME_EXITED, &completion)?;
    drop(status_file);
    drop(pidfd);
    drop(group_fd);
    drop(tree);
    drop(group);
    Ok(result.0)
}

fn runtime_args(args: &[String]) -> Result<(PathBuf, PathBuf)> {
    let mut cgroup = None;
    let mut scratch = None;
    let mut i = 0;
    while i < args.len() {
        let name = &args[i];
        i += 1;
        let value = args
            .get(i)
            .ok_or_else(|| format!("missing value for {name}"))?;
        match name.as_str() {
            "--cgroup-root" => cgroup = Some(PathBuf::from(value)),
            "--scratch-root" => scratch = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown probe option {name}")),
        }
        i += 1;
    }
    Ok((
        cgroup.ok_or_else(|| "missing --cgroup-root".to_string())?,
        scratch.ok_or_else(|| "missing --scratch-root".to_string())?,
    ))
}
pub fn probe(args: &[String]) -> Result<()> {
    let (cgroup_root, scratch_root) = runtime_args(args)?;
    private_directory(&scratch_root)?;
    let executable = fs::canonicalize("/usr/bin/true")
        .or_else(|_| fs::canonicalize("/bin/true"))
        .map_err(|_| "probe requires true executable")?;
    let mut read = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for path in ["/usr", "/lib", "/lib64", "/etc/ld.so.cache"] {
        let Ok(value) = fs::canonicalize(path) else {
            continue;
        };
        if seen.insert(value.clone()) {
            let scope = if value.is_dir() {
                Scope::Tree
            } else {
                Scope::Exact
            };
            read.push(Grant { path: value, scope });
        }
    }
    let status = scratch_root.join(unique("probe-status"));
    let status_guard = OwnedFilePath {
        path: status.clone(),
    };
    let config = RunConfig {
        network: "deny".into(),
        cwd: PathBuf::from("/"),
        status_file: status.clone(),
        cgroup_root,
        scratch_root,
        limits: crate::config::Limits {
            cpu_time_ms: 1000,
            memory_bytes: 64 * 1024 * 1024,
            processes: 4,
            write_bytes: 1024 * 1024,
        },
        read,
        write: Vec::new(),
        deny: Vec::new(),
        executable,
        arguments: Vec::new(),
    };
    let code = run(config)?;
    drop(status_guard);
    if code != 0 {
        return Err(format!("native isolation self-test exited {code}"));
    }
    println!("{{\"protocol\":2,\"platform\":\"linux\",\"modes\":[\"namespace-cgroup-seccomp-deny\"],\"namespaces\":[\"user\",\"mount\",\"pid\",\"ipc\",\"uts\",\"network\"],\"resourceLimits\":[\"cpu_time\",\"memory\",\"process_count\",\"write_bytes\"],\"cgroupV2\":true,\"cgroupKill\":true,\"pidfd\":true,\"seccomp\":true,\"noNewPrivileges\":true,\"filesystemPolicy\":true,\"terminal\":true,\"atomicCgroupAssignment\":true,\"cgroupEmptyBarrier\":true}}");
    Ok(())
}

fn owned_entries(root: &Path, prefix: &str) -> Result<Vec<PathBuf>> {
    let mut entries = Vec::new();
    for entry in context(fs::read_dir(root), "runtime recovery directory read failed")? {
        let entry = context(entry, "runtime recovery entry read failed")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(prefix) || name.len() == prefix.len() {
            continue;
        }
        let kind = context(entry.file_type(), "runtime recovery metadata failed")?;
        if kind.is_dir() && !kind.is_symlink() {
            entries.push(entry.path());
        }
    }
    entries.sort();
    Ok(entries)
}

pub fn recover(args: &[String]) -> Result<()> {
    let (cgroup_root, scratch_root) = runtime_args(args)?;
    private_directory(&scratch_root)?;
    let cgroup_root = context(fs::canonicalize(cgroup_root), "cgroup root is unavailable")?;
    if !cgroup_root.join("cgroup.controllers").is_file() {
        return Err("cgroup root is not a delegated cgroup v2 directory".into());
    }
    let mut recovered_cgroups = 0u64;
    let mut recovered_scratch = 0u64;
    for group in owned_entries(&cgroup_root, "traceforge-execution-")? {
        if read_number(group.join("pids.current"))? > 0 {
            write_control(group.join("cgroup.kill"), b"1")?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while read_number(group.join("pids.current"))? > 0 {
                if Instant::now() >= deadline {
                    return Err("recovery cgroup cleanup deadline exceeded".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        context(fs::remove_dir(&group), "recovered cgroup removal failed")?;
        recovered_cgroups += 1;
    }
    // Recovery is an exclusive startup operation. Once every owned cgroup is
    // empty and removed, any owned run tree is necessarily crash residue.
    for run_root in owned_entries(&scratch_root, "run-execution-")? {
        context(
            fs::remove_dir_all(run_root),
            "recovered scratch removal failed",
        )?;
        recovered_scratch += 1;
    }
    println!(
        "{{\"protocol\":2,\"recoveredCgroups\":{recovered_cgroups},\"recoveredScratchTrees\":{recovered_scratch}}}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_field;

    #[test]
    fn parses_non_first_cgroup_event_field() {
        let events = "low 0\nhigh 0\nmax 35\noom 1\noom_kill 2\noom_group_kill 1\n";
        assert_eq!(parse_field(events, "oom_kill"), 2);
        assert_eq!(parse_field(events, "missing"), 0);
    }
}
