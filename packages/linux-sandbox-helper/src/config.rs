use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Scope {
    Exact,
    Tree,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Grant {
    pub path: PathBuf,
    pub scope: Scope,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Limits {
    pub cpu_time_ms: u64,
    pub memory_bytes: u64,
    pub processes: u64,
    pub write_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunConfig {
    pub network: String,
    pub cwd: PathBuf,
    pub status_file: PathBuf,
    pub cgroup_root: PathBuf,
    pub scratch_root: PathBuf,
    pub limits: Limits,
    pub read: Vec<Grant>,
    pub write: Vec<Grant>,
    pub deny: Vec<Grant>,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PtyRunConfig {
    pub run: RunConfig,
    pub execution_nonce: String,
    pub columns: u16,
    pub rows: u16,
}

fn value(args: &[String], index: &mut usize, name: &str) -> Result<String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}

fn positive(value: String, name: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn absolute(value: String, name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{name} must be absolute"));
    }
    Ok(path)
}

pub fn parse_run(args: &[String]) -> Result<RunConfig> {
    let mut network = None;
    let mut cwd = None;
    let mut status = None;
    let mut cgroup = None;
    let mut scratch = None;
    let mut cpu = None;
    let mut memory = None;
    let mut processes = None;
    let mut writes = None;
    let mut read = Vec::new();
    let mut write = Vec::new();
    let mut deny = Vec::new();
    let mut command = None;
    let mut index = 0;
    while index < args.len() {
        let name = &args[index];
        if name == "--" {
            command = Some(args[index + 1..].to_vec());
            break;
        }
        let (target, scope) = match name.as_str() {
            "--read-exact" => (&mut read, Some(Scope::Exact)),
            "--read-tree" => (&mut read, Some(Scope::Tree)),
            "--write-exact" => (&mut write, Some(Scope::Exact)),
            "--write-tree" => (&mut write, Some(Scope::Tree)),
            "--deny-exact" => (&mut deny, Some(Scope::Exact)),
            "--deny-tree" => (&mut deny, Some(Scope::Tree)),
            _ => (&mut read, None),
        };
        if let Some(scope) = scope {
            let path = absolute(value(args, &mut index, name)?, name)?;
            target.push(Grant { path, scope });
            index += 1;
            continue;
        }
        let item = value(args, &mut index, name)?;
        match name.as_str() {
            "--network" => network = Some(item),
            "--cwd" => cwd = Some(absolute(item, name)?),
            "--status-file" => status = Some(absolute(item, name)?),
            "--cgroup-root" => cgroup = Some(absolute(item, name)?),
            "--scratch-root" => scratch = Some(absolute(item, name)?),
            "--cpu-time-ms" => cpu = Some(positive(item, name)?),
            "--memory-bytes" => memory = Some(positive(item, name)?),
            "--max-processes" => processes = Some(positive(item, name)?),
            "--write-bytes" => writes = Some(positive(item, name)?),
            _ => return Err(format!("unknown option {name}")),
        }
        index += 1;
    }
    let command = command
        .filter(|items| !items.is_empty())
        .ok_or_else(|| "missing command after --".to_string())?;
    let executable = absolute(command[0].clone(), "executable")?;
    let network = network.ok_or_else(|| "missing --network".to_string())?;
    if network != "deny" {
        return Err("Linux helper supports only deny networking".into());
    }
    Ok(RunConfig {
        network,
        cwd: cwd.ok_or_else(|| "missing --cwd".to_string())?,
        status_file: status.ok_or_else(|| "missing --status-file".to_string())?,
        cgroup_root: cgroup.ok_or_else(|| "missing --cgroup-root".to_string())?,
        scratch_root: scratch.ok_or_else(|| "missing --scratch-root".to_string())?,
        limits: Limits {
            cpu_time_ms: cpu.ok_or_else(|| "missing --cpu-time-ms".to_string())?,
            memory_bytes: memory.ok_or_else(|| "missing --memory-bytes".to_string())?,
            processes: processes.ok_or_else(|| "missing --max-processes".to_string())?,
            write_bytes: writes.ok_or_else(|| "missing --write-bytes".to_string())?,
        },
        read,
        write,
        deny,
        executable,
        arguments: command[1..].to_vec(),
    })
}

pub fn parse_pty_run(args: &[String]) -> Result<PtyRunConfig> {
    let mut execution_nonce = None;
    let mut columns = None;
    let mut rows = None;
    let mut run_args = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--" {
            run_args.extend_from_slice(&args[index..]);
            break;
        }
        match args[index].as_str() {
            "--execution-nonce" | "--columns" | "--rows" => {
                let name = args[index].clone();
                let value = args
                    .get(index + 1)
                    .cloned()
                    .ok_or_else(|| format!("missing value for {name}"))?;
                match name.as_str() {
                    "--execution-nonce" => execution_nonce = Some(value),
                    "--columns" => columns = Some(positive(value, &name)?),
                    "--rows" => rows = Some(positive(value, &name)?),
                    _ => unreachable!(),
                }
                index += 2;
            }
            _ => {
                run_args.push(args[index].clone());
                if args[index].starts_with("--") {
                    run_args.push(
                        args.get(index + 1)
                            .cloned()
                            .ok_or_else(|| format!("missing value for {}", args[index]))?,
                    );
                    index += 2;
                } else {
                    index += 1;
                }
            }
        }
    }
    let execution_nonce = execution_nonce.ok_or_else(|| "missing --execution-nonce".to_string())?;
    if execution_nonce.len() != 64
        || !execution_nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid --execution-nonce".into());
    }
    let columns = columns
        .filter(|value| *value <= u16::MAX as u64)
        .ok_or_else(|| "invalid --columns".to_string())? as u16;
    let rows = rows
        .filter(|value| *value <= u16::MAX as u64)
        .ok_or_else(|| "invalid --rows".to_string())? as u16;
    Ok(PtyRunConfig {
        run: parse_run(&run_args)?,
        execution_nonce,
        columns,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn valid() -> Vec<String> {
        [
            "--network",
            "deny",
            "--cwd",
            "/work",
            "--status-file",
            "/tmp/status",
            "--cgroup-root",
            "/sys/fs/cgroup/traceforge",
            "--scratch-root",
            "/tmp/traceforge",
            "--cpu-time-ms",
            "1000",
            "--memory-bytes",
            "4096",
            "--max-processes",
            "2",
            "--write-bytes",
            "1024",
            "--read-exact",
            "/bin/tool",
            "--write-tree",
            "/work",
            "--deny-tree",
            "/work/private",
            "--",
            "/bin/tool",
            "arg",
        ]
        .map(str::to_string)
        .to_vec()
    }
    #[test]
    fn parses_complete_vector_without_shell_interpretation() {
        let value = parse_run(&valid()).unwrap();
        assert_eq!(value.executable, PathBuf::from("/bin/tool"));
        assert_eq!(value.arguments, ["arg"]);
        assert_eq!(value.write[0].scope, Scope::Tree);
    }
    #[test]
    fn rejects_non_denied_network_and_relative_paths() {
        let mut args = valid();
        args[1] = "direct".into();
        assert!(parse_run(&args).unwrap_err().contains("only deny"));
        let mut args = valid();
        args[3] = "relative".into();
        assert!(parse_run(&args).unwrap_err().contains("absolute"));
    }
    #[test]
    fn rejects_missing_or_zero_limits_and_unknown_options() {
        let mut args = valid();
        args[11] = "0".into();
        assert!(parse_run(&args).is_err());
        let mut args = valid();
        args[0] = "--mystery".into();
        assert!(parse_run(&args).is_err());
    }
    #[test]
    fn parses_terminal_control_without_weakening_the_run_profile() {
        let mut args = [
            "--execution-nonce",
            &"a".repeat(64),
            "--columns",
            "120",
            "--rows",
            "40",
        ]
        .map(str::to_string)
        .to_vec();
        args.extend(valid());
        let value = parse_pty_run(&args).unwrap();
        assert_eq!((value.columns, value.rows), (120, 40));
        assert_eq!(value.run.executable, PathBuf::from("/bin/tool"));
        args[1] = "bad".into();
        assert!(parse_pty_run(&args).unwrap_err().contains("nonce"));
    }
}
