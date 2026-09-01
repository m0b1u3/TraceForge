//! Completion requires an observed empty owned job, not a successful termination request.
//! Kept platform-independent so failure ordering is tested without pretending to test Windows.
pub fn terminate_and_confirm(
    terminate: impl FnOnce() -> Result<(), String>,
    mut active_processes: impl FnMut() -> Result<u32, String>,
    mut wait_next: impl FnMut() -> bool,
) -> Result<(), String> {
    terminate()?;
    loop {
        if active_processes()? == 0 {
            return Ok(());
        }
        if !wait_next() {
            return Err("owned job cleanup timed out with active processes".to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirms_only_after_the_last_descendant_exits() {
        let mut counts = [3, 2, 1, 0].into_iter();
        let mut waits = 0;
        terminate_and_confirm(
            || Ok(()),
            || Ok(counts.next().unwrap()),
            || {
                waits += 1;
                true
            },
        )
        .unwrap();
        assert_eq!(waits, 3);
    }

    #[test]
    fn rejects_termination_failure_without_querying() {
        let result = terminate_and_confirm(
            || Err("terminate failed".into()),
            || panic!("must not query"),
            || true,
        );
        assert_eq!(result.unwrap_err(), "terminate failed");
    }

    #[test]
    fn rejects_unavailable_accounting() {
        let result = terminate_and_confirm(|| Ok(()), || Err("query failed".into()), || true);
        assert_eq!(result.unwrap_err(), "query failed");
    }

    #[test]
    fn acknowledgment_does_not_bypass_timeout() {
        let result = terminate_and_confirm(|| Ok(()), || Ok(1), || false);
        assert!(result.unwrap_err().contains("timed out"));
    }

    #[test]
    fn accepts_an_already_empty_job_without_waiting() {
        terminate_and_confirm(|| Ok(()), || Ok(0), || panic!("must not wait")).unwrap();
    }

    #[test]
    fn later_query_failure_does_not_reuse_an_earlier_count() {
        let mut observations = [Ok(1), Err("accounting lost".to_string())].into_iter();
        assert_eq!(
            terminate_and_confirm(|| Ok(()), || observations.next().unwrap(), || true).unwrap_err(),
            "accounting lost"
        );
    }
}
