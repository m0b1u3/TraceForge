#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod cleanup;
mod config;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("traceforge-linux-sandbox is only available on Linux");
    std::process::exit(125);
}

#[cfg(target_os = "linux")]
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match args.first().map(String::as_str) {
        Some("probe") => linux::probe(&args[1..]),
        Some("recover") => linux::recover(&args[1..]),
        Some("run") => config::parse_run(&args[1..])
            .and_then(linux::run)
            .map(|code| std::process::exit(code)),
        Some("pty-run") => config::parse_pty_run(&args[1..])
            .and_then(linux::pty_run)
            .map(|code| std::process::exit(code)),
        _ => Err("usage: traceforge-linux-sandbox probe|recover|run|pty-run".into()),
    };
    if let Err(error) = result {
        eprintln!("traceforge-linux-sandbox: {error}");
        std::process::exit(125);
    }
}
