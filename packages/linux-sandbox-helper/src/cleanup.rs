const SIGKILL_EXIT: i32 = 137;

pub fn supervise(
    mut sample: impl FnMut() -> Result<(u64, u64, u64, bool, bool), String>,
    mut root_exited: impl FnMut() -> Result<Option<i32>, String>,
    mut kill: impl FnMut() -> Result<(), String>,
    mut wait: impl FnMut(bool) -> bool,
    cpu_limit: u64,
    write_limit: u64,
) -> Result<(i32, Option<&'static str>), String> {
    let limit_reason = |cpu, writes, oom, process_limit| {
        if oom {
            Some("memory")
        } else if process_limit {
            Some("process_count")
        } else if cpu > cpu_limit {
            Some("cpu_time")
        } else if writes > write_limit {
            Some("write_bytes")
        } else {
            None
        }
    };
    let mut reason = None;
    let mut exit = None;
    loop {
        let (cpu, writes, pids, oom, process_limit) = sample()?;
        if reason.is_none() {
            reason = limit_reason(cpu, writes, oom, process_limit);
            if reason.is_some() {
                kill()?;
            }
        }
        if exit.is_none() {
            exit = root_exited()?;
        }
        if exit.is_some() {
            kill()?;
            if pids == 0 {
                // The task can become waitable just before cgroup event files
                // publish an OOM kill. Briefly re-sample SIGKILL exits so the
                // durable resource reason is not lost at that accounting edge.
                if reason.is_none() && exit == Some(SIGKILL_EXIT) {
                    for _ in 0..5 {
                        if !wait(true) {
                            return Err("cgroup accounting settlement deadline exceeded".into());
                        }
                        let (cpu, writes, _, oom, process_limit) = sample()?;
                        reason = limit_reason(cpu, writes, oom, process_limit);
                        if reason.is_some() {
                            break;
                        }
                    }
                }
                return Ok((exit.unwrap(), reason));
            }
        }
        if !wait(exit.is_some() || reason.is_some()) {
            return Err("cgroup process-tree cleanup deadline exceeded".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kills_on_cpu_and_waits_for_empty_tree() {
        let mut samples = [
            (11, 0, 2, false, false),
            (11, 0, 1, false, false),
            (11, 0, 0, false, false),
        ]
        .into_iter();
        let mut killed = 0;
        let value = supervise(
            || Ok(samples.next().unwrap()),
            || Ok(Some(0)),
            || {
                killed += 1;
                Ok(())
            },
            |_| true,
            10,
            100,
        )
        .unwrap();
        assert_eq!(value, (0, Some("cpu_time")));
        assert!(killed >= 1);
    }
    #[test]
    fn root_exit_is_not_tree_cleanup() {
        let mut samples = [(0, 0, 1, false, false), (0, 0, 0, false, false)].into_iter();
        let mut killed = 0;
        supervise(
            || Ok(samples.next().unwrap()),
            || Ok(Some(7)),
            || {
                killed += 1;
                Ok(())
            },
            |_| true,
            10,
            10,
        )
        .unwrap();
        assert!(killed >= 1);
    }
    #[test]
    fn accounting_failure_is_not_success() {
        assert_eq!(
            supervise(
                || Err("lost".into()),
                || Ok(None),
                || Ok(()),
                |_| true,
                1,
                1
            )
            .unwrap_err(),
            "lost"
        );
    }
    #[test]
    fn cleanup_deadline_is_fail_closed() {
        assert!(supervise(
            || Ok((0, 0, 1, false, false)),
            || Ok(Some(0)),
            || Ok(()),
            |_| false,
            1,
            1
        )
        .unwrap_err()
        .contains("deadline"));
    }

    #[test]
    fn captures_late_oom_accounting_after_sigkill_exit() {
        let mut samples = [(0, 0, 0, false, false), (0, 0, 0, true, false)].into_iter();
        assert_eq!(
            supervise(
                || Ok(samples.next().unwrap()),
                || Ok(Some(SIGKILL_EXIT)),
                || Ok(()),
                |_| true,
                1,
                1,
            )
            .unwrap(),
            (SIGKILL_EXIT, Some("memory"))
        );
    }
}
