use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    JobObjectBasicAndIoAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug)]
pub struct ResourceLimits {
    pub cpu_time_ms: u64,
    pub memory_bytes: u64,
    pub maximum_processes: u32,
    pub write_bytes: u64,
}

impl ResourceLimits {
    pub fn validate(&self) -> Result<()> {
        if self.cpu_time_ms == 0
            || self.memory_bytes == 0
            || self.maximum_processes == 0
            || self.write_bytes == 0
        {
            return Err("resource limits must be positive".to_string());
        }
        if self.cpu_time_ms > i64::MAX as u64 / 10_000 {
            return Err("CPU time limit is too large".to_string());
        }
        if self.memory_bytes > usize::MAX as u64 {
            return Err("memory limit is too large for this platform".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceLimitKind {
    CpuTime,
    Memory,
    ProcessCount,
    WriteBytes,
}

impl ResourceLimitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CpuTime => "cpu_time",
            Self::Memory => "memory",
            Self::ProcessCount => "process_count",
            Self::WriteBytes => "write_bytes",
        }
    }

    fn termination_code(self) -> u32 {
        match self {
            Self::CpuTime => 0xE001_0001,
            Self::Memory => 0xE001_0002,
            Self::ProcessCount => 0xE001_0003,
            Self::WriteBytes => 0xE001_0004,
        }
    }
}

pub unsafe fn configure(job: HANDLE, limits: ResourceLimits) -> Result<()> {
    limits.validate()?;
    let mut value: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    value.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_JOB_TIME
        | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    value.BasicLimitInformation.PerJobUserTimeLimit = (limits.cpu_time_ms * 10_000) as i64;
    value.BasicLimitInformation.ActiveProcessLimit = limits.maximum_processes;
    value.JobMemoryLimit = limits.memory_bytes as usize;
    if SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &value as *const _ as *const c_void,
        std::mem::size_of_val(&value) as u32,
    ) == 0
    {
        return Err(format!(
            "SetInformationJobObject(resource limits) failed: {}",
            GetLastError()
        ));
    }
    Ok(())
}

pub struct ResourceMonitor {
    job: usize,
    limits: ResourceLimits,
    stop: Arc<AtomicBool>,
    receiver: mpsc::Receiver<Result<ResourceLimitKind>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ResourceMonitor {
    pub unsafe fn start(job: HANDLE, limits: ResourceLimits) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (sender, receiver) = mpsc::channel();
        let job_value = job as usize;
        let thread = thread::spawn(move || {
            let job = job_value as HANDLE;
            while !thread_stop.load(Ordering::Acquire) {
                match unsafe { observe(job, limits) } {
                    Ok(Some(resource)) => {
                        let _ = sender.send(Ok(resource));
                        unsafe {
                            TerminateJobObject(job, resource.termination_code());
                        }
                        return;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(10)),
                    Err(error) => {
                        // A query failure makes enforcement unverifiable, so terminate the tree.
                        let _ = sender.send(Err(error));
                        unsafe {
                            TerminateJobObject(job, 0xE001_00FF);
                        }
                        return;
                    }
                }
            }
        });
        Self {
            job: job_value,
            limits,
            stop,
            receiver,
            thread: Some(thread),
        }
    }

    pub fn finish(mut self) -> Result<Option<ResourceLimitKind>> {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        match self.receiver.try_recv() {
            Ok(result) => result.map(Some),
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => unsafe {
                observe(self.job as HANDLE, self.limits)
            },
        }
    }
}

unsafe fn observe(job: HANDLE, limits: ResourceLimits) -> Result<Option<ResourceLimitKind>> {
    let mut accounting: JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION = std::mem::zeroed();
    if QueryInformationJobObject(
        job,
        JobObjectBasicAndIoAccountingInformation,
        &mut accounting as *mut _ as *mut c_void,
        std::mem::size_of_val(&accounting) as u32,
        std::ptr::null_mut(),
    ) == 0
    {
        return Err(format!(
            "QueryInformationJobObject(accounting) failed: {}",
            GetLastError()
        ));
    }
    let cpu_ticks = accounting
        .BasicInfo
        .TotalUserTime
        .saturating_add(accounting.BasicInfo.TotalKernelTime)
        .max(0) as u64;
    if cpu_ticks >= limits.cpu_time_ms.saturating_mul(10_000) {
        return Ok(Some(ResourceLimitKind::CpuTime));
    }
    if accounting.BasicInfo.ActiveProcesses > limits.maximum_processes {
        return Ok(Some(ResourceLimitKind::ProcessCount));
    }
    if accounting.IoInfo.WriteTransferCount >= limits.write_bytes {
        return Ok(Some(ResourceLimitKind::WriteBytes));
    }

    let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    if QueryInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &mut extended as *mut _ as *mut c_void,
        std::mem::size_of_val(&extended) as u32,
        std::ptr::null_mut(),
    ) == 0
    {
        return Err(format!(
            "QueryInformationJobObject(memory) failed: {}",
            GetLastError()
        ));
    }
    if extended.PeakJobMemoryUsed as u64 >= limits.memory_bytes {
        return Ok(Some(ResourceLimitKind::Memory));
    }
    Ok(None)
}
