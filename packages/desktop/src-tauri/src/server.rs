use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::PathBuf, process::Stdio, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{oneshot, Mutex as AsyncMutex},
};

use crate::config;

const DESKTOP_BOOTSTRAP_PROTOCOL_VERSION: u8 = 1;
const DESKTOP_READY_PREFIX: &str = "YEP_DESKTOP_READY ";
const MAX_SERVER_OUTPUT_BYTES: usize = 1024 * 1024;
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
pub struct ServerOutputChunk {
    pub sequence: u64,
    pub stream: String,
    pub data: String,
}

#[derive(Deserialize)]
struct DesktopReady {
    protocol: u8,
    port: u16,
}

#[derive(Deserialize)]
struct MintBootstrapResponse {
    code: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServerPhase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

impl ServerPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ServerLifecycle {
    phase: ServerPhase,
    attempt: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartDecision {
    AlreadyRunning,
    ShareFailure,
    Start,
    RejectStopping,
}

fn decide_start(observed: ServerLifecycle, current: ServerLifecycle) -> StartDecision {
    if current.phase == ServerPhase::Running {
        return StartDecision::AlreadyRunning;
    }
    if observed.phase == ServerPhase::Stopping || current.phase == ServerPhase::Stopping {
        return StartDecision::RejectStopping;
    }
    if current.phase == ServerPhase::Error
        && (observed.phase == ServerPhase::Starting || current.attempt != observed.attempt)
    {
        return StartDecision::ShareFailure;
    }
    StartDecision::Start
}

struct ServerOutputBuffer {
    chunks: VecDeque<ServerOutputChunk>,
    bytes: usize,
    next_sequence: u64,
}

impl ServerOutputBuffer {
    fn new() -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            next_sequence: 1,
        }
    }

    fn push(&mut self, stream: &str, data: String) -> ServerOutputChunk {
        let chunk = ServerOutputChunk {
            sequence: self.next_sequence,
            stream: stream.to_string(),
            data,
        };
        self.next_sequence += 1;
        self.bytes += chunk.data.len();
        self.chunks.push_back(chunk.clone());

        while self.bytes > MAX_SERVER_OUTPUT_BYTES {
            let Some(removed) = self.chunks.pop_front() else {
                self.bytes = 0;
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.data.len());
        }

        chunk
    }

    fn snapshot(&self) -> Vec<ServerOutputChunk> {
        self.chunks.iter().cloned().collect()
    }
}

pub struct ServerState {
    child: Mutex<Option<Child>>,
    process_job: Mutex<Option<ProcessJob>>,
    bootstrap_secret: Mutex<Option<String>>,
    port: Mutex<Option<u16>>,
    last_error: Mutex<Option<String>>,
    output: Mutex<ServerOutputBuffer>,
    lifecycle: Mutex<ServerLifecycle>,
    operation_gate: AsyncMutex<()>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            process_job: Mutex::new(None),
            bootstrap_secret: Mutex::new(None),
            port: Mutex::new(None),
            last_error: Mutex::new(None),
            output: Mutex::new(ServerOutputBuffer::new()),
            lifecycle: Mutex::new(ServerLifecycle {
                phase: ServerPhase::Stopped,
                attempt: 0,
            }),
            operation_gate: AsyncMutex::new(()),
        }
    }

    fn lifecycle(&self) -> Result<ServerLifecycle, String> {
        self.lifecycle
            .lock()
            .map(|lifecycle| *lifecycle)
            .map_err(|error| error.to_string())
    }

    fn set_phase(&self, phase: ServerPhase) -> Result<ServerLifecycle, String> {
        let mut lifecycle = self.lifecycle.lock().map_err(|error| error.to_string())?;
        lifecycle.phase = phase;
        Ok(*lifecycle)
    }

    fn begin_start(&self) -> Result<ServerLifecycle, String> {
        let mut lifecycle = self.lifecycle.lock().map_err(|error| error.to_string())?;
        lifecycle.attempt = lifecycle.attempt.saturating_add(1);
        lifecycle.phase = ServerPhase::Starting;
        Ok(*lifecycle)
    }

    /// Called during app exit, when the async runtime may no longer be usable.
    pub fn kill_sync(&self) {
        if let Ok(mut job) = self.process_job.lock() {
            // Closing a Windows job configured with KILL_ON_JOB_CLOSE is the
            // final ownership guarantee for every descendant.
            *job = None;
        }
        if let Ok(mut lock) = self.child.lock() {
            if let Some(ref mut child) = *lock {
                if let Some(pid) = child.id() {
                    kill_process_tree_sync(pid);
                }
                let _ = child.start_kill();
            }
            *lock = None;
        }
        if let Ok(mut secret) = self.bootstrap_secret.lock() {
            *secret = None;
        }
        if let Ok(mut port) = self.port.lock() {
            *port = None;
        }
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.phase = ServerPhase::Stopped;
        }
    }
}

#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for ProcessJob {}

#[cfg(windows)]
unsafe impl Sync for ProcessJob {}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
struct ProcessJob;

#[cfg(windows)]
fn assign_process_job(child: &Child) -> Result<ProcessJob, String> {
    use windows_sys::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!(
            "Could not create desktop process job: {}",
            std::io::Error::last_os_error()
        ));
    }
    let owned_job = ProcessJob(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(format!(
            "Could not configure desktop process job: {}",
            std::io::Error::last_os_error()
        ));
    }
    let process = child.raw_handle().ok_or_else(|| {
        "Bundled server exited before process ownership was established".to_string()
    })? as HANDLE;
    let assigned = unsafe { AssignProcessToJobObject(job, process) };
    if assigned == 0 {
        return Err(format!(
            "Could not assign bundled server to desktop process job: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(owned_job)
}

#[cfg(not(windows))]
fn assign_process_job(_child: &Child) -> Result<ProcessJob, String> {
    Ok(ProcessJob)
}

fn generate_secret() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn redact_after_marker(mut text: String, marker: &str) -> String {
    let mut search_from = 0;
    while let Some(relative_pos) = text[search_from..].find(marker) {
        let value_start = search_from + relative_pos + marker.len();
        let mut value_end = value_start;

        for (offset, ch) in text[value_start..].char_indices() {
            if ch.is_whitespace() || matches!(ch, '&' | '"' | '\'' | '<' | '>') {
                break;
            }
            value_end = value_start + offset + ch.len_utf8();
        }

        text.replace_range(value_start..value_end, "[redacted]");
        search_from = value_start + "[redacted]".len();
    }
    text
}

fn redact_server_output(data: String) -> String {
    let data = redact_after_marker(data, "desktop_token=");
    let data = redact_after_marker(data, "DESKTOP_AUTH_TOKEN=");
    redact_after_marker(data, "x-yep-desktop-bootstrap-secret:")
}

fn record_server_output(app: &AppHandle, stream: &str, data: String) {
    let data = redact_server_output(data);
    let state = app.state::<ServerState>();
    let chunk = match state.output.lock() {
        Ok(mut output) => output.push(stream, data),
        Err(_) => return,
    };
    let _ = app.emit("server-output", chunk);
}

fn spawn_stdout_reader<R>(
    app: AppHandle,
    reader: R,
    ready_tx: oneshot::Sender<Result<DesktopReady, String>>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        let mut ready_tx = Some(ready_tx);
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if let Some(payload) = line.strip_prefix(DESKTOP_READY_PREFIX) {
                        let result = serde_json::from_str::<DesktopReady>(payload)
                            .map_err(|error| format!("Invalid desktop readiness record: {error}"));
                        if let Some(sender) = ready_tx.take() {
                            let _ = sender.send(result);
                        }
                    }
                    record_server_output(&app, "stdout", format!("{line}\n"));
                }
                Ok(None) => {
                    if let Some(sender) = ready_tx.take() {
                        let _ = sender.send(Err(
                            "Server exited before reporting desktop readiness".to_string(),
                        ));
                    }
                    break;
                }
                Err(error) => {
                    if let Some(sender) = ready_tx.take() {
                        let _ =
                            sender.send(Err(format!("Failed to read desktop readiness: {error}")));
                    }
                    record_server_output(
                        &app,
                        "system",
                        format!("\r\n[server output read error: {error}]\r\n"),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_output_reader<R>(app: AppHandle, stream: &'static str, mut reader: R)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut buf = [0_u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(count) => {
                    record_server_output(
                        &app,
                        stream,
                        String::from_utf8_lossy(&buf[..count]).to_string(),
                    );
                }
                Err(error) => {
                    record_server_output(
                        &app,
                        "system",
                        format!("\r\n[server output read error: {error}]\r\n"),
                    );
                    break;
                }
            }
        }
    });
}

#[cfg(any(windows, test))]
const IMAGE_FILE_MACHINE_ARM64_VALUE: u16 = 0xaa64;

#[cfg(any(windows, test))]
fn needs_windows_arm64_bun(compiled_for_x86_64: bool, native_machine: u16) -> bool {
    compiled_for_x86_64 && native_machine == IMAGE_FILE_MACHINE_ARM64_VALUE
}

#[cfg(windows)]
fn windows_native_machine() -> Result<u16, String> {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};

    let mut process_machine = 0;
    let mut native_machine = 0;
    let detected = unsafe {
        IsWow64Process2(
            GetCurrentProcess(),
            &mut process_machine,
            &mut native_machine,
        )
    };
    if detected == 0 {
        return Err(format!(
            "Could not detect native Windows architecture: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(native_machine)
}

#[cfg(any(windows, test))]
fn windows_arm64_bun_candidates(resource_dir: &std::path::Path) -> [PathBuf; 2] {
    [
        resource_dir.join("server").join("bun-windows-aarch64.exe"),
        resource_dir
            .join("resources")
            .join("server")
            .join("bun-windows-aarch64.exe"),
    ]
}

fn bun_path(_app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let native_machine = windows_native_machine()?;
        // Current Windows 11 ARM64 builds can report IMAGE_FILE_MACHINE_UNKNOWN
        // for an emulated x64 process, so the shell's compile target is the
        // authoritative process architecture here.
        if needs_windows_arm64_bun(cfg!(target_arch = "x86_64"), native_machine) {
            let resource_dir = _app
                .path()
                .resource_dir()
                .map_err(|error| format!("Could not resolve desktop resources: {error}"))?;
            let candidates = windows_arm64_bun_candidates(&resource_dir);
            return candidates
                .iter()
                .find(|candidate| candidate.exists())
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "Bundled Windows ARM64 runtime not found beneath {}",
                        resource_dir.display()
                    )
                });
        }
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not resolve executable: {error}"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "Could not resolve executable directory".to_string())?;
    let name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let path = executable_dir.join(name);
    path.exists()
        .then_some(path.clone())
        .ok_or_else(|| format!("Bundled Bun runtime not found at {}", path.display()))
}

fn server_entry_candidates(resource_dir: &std::path::Path) -> [PathBuf; 2] {
    [
        resource_dir.join("server").join("dist").join("index.js"),
        resource_dir
            .join("resources")
            .join("server")
            .join("dist")
            .join("index.js"),
    ]
}

fn server_entry(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not resolve desktop resources: {error}"))?;
    let candidates = server_entry_candidates(&resource_dir);
    candidates
        .iter()
        .find(|entry| entry.exists())
        .cloned()
        .ok_or_else(|| {
            format!(
                "Bundled Yep Anywhere server not found beneath {}",
                resource_dir.display()
            )
        })
}

fn apply_desktop_server_env(command: &mut Command, port: u16, data_dir: &std::path::Path) {
    command
        .env("NODE_ENV", "production")
        .env("PORT", port.to_string())
        .env("YEP_DATA_DIR", data_dir)
        .env("YEP_DESKTOP", "1")
        .env(
            "YEP_SQLITE",
            std::env::var_os("YEP_SQLITE").unwrap_or_else(|| "auto".into()),
        )
        .env("YEP_DESKTOP_BOOTSTRAP", "stdin-v1")
        .env_remove("DESKTOP_AUTH_TOKEN");
}

fn setup_child_process(command: &mut Command) {
    command.kill_on_drop(true);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
}

fn create_server_command(
    app: &AppHandle,
    port: u16,
    data_dir: &std::path::Path,
) -> Result<Command, String> {
    if let Some(dev_dir) = config::dev_dir() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("pnpm.cmd");
            command.arg("dev");
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let mut command = Command::new(shell);
            command.args(["-l", "-c", "exec pnpm dev"]);
            command
        };
        command.current_dir(dev_dir);
        apply_desktop_server_env(&mut command, port, data_dir);
        setup_child_process(&mut command);
        return Ok(command);
    }

    let bun = bun_path(app)?;
    let entry = server_entry(app)?;
    let server_dir = entry
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or_else(|| "Could not resolve bundled server directory".to_string())?;
    let mut command = Command::new(bun);
    command.arg("run").arg(&entry).current_dir(server_dir);
    apply_desktop_server_env(&mut command, port, data_dir);
    setup_child_process(&mut command);
    Ok(command)
}

async fn send_startup_frame(child: &mut Child, secret: &str) -> Result<(), String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Desktop server stdin was not piped".to_string())?;
    let frame = serde_json::json!({
        "protocol": DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
        "masterSecret": secret,
    });
    stdin
        .write_all(format!("{frame}\n").as_bytes())
        .await
        .map_err(|error| format!("Failed to send desktop startup frame: {error}"))?;
    stdin
        .shutdown()
        .await
        .map_err(|error| format!("Failed to close desktop startup pipe: {error}"))
}

#[cfg(windows)]
fn kill_process_tree_sync(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(unix)]
fn kill_process_tree_sync(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
}

async fn request_graceful_shutdown(port: u16, secret: &str) -> Result<(), String> {
    let base_url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| error.to_string())?;
    let mint = client
        .post(format!("{base_url}/desktop-bootstrap/mint"))
        .header("x-yep-desktop-bootstrap-secret", secret)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let code = mint
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<MintBootstrapResponse>()
        .await
        .map_err(|error| error.to_string())?
        .code;
    let exchange = client
        .get(format!("{base_url}/desktop-bootstrap/{code}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let cookie = exchange
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .ok_or_else(|| "Desktop shutdown bootstrap did not return a cookie".to_string())?;
    client
        .post(format!("{base_url}/api/server/restart"))
        .header(reqwest::header::COOKIE, cookie)
        .header("X-Yep-Anywhere", "true")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn stop_child(
    mut child: Child,
    mut process_job: Option<ProcessJob>,
    graceful: Option<(u16, String)>,
) -> Result<(), String> {
    if let Some((port, secret)) = graceful {
        let _ = request_graceful_shutdown(port, &secret).await;
        if let Ok(result) = tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            process_job.take();
            return result
                .map(|_| ())
                .map_err(|error| format!("Failed waiting for server shutdown: {error}"));
        }
    }

    // Closing the Windows job terminates the complete owned tree. The
    // PID-specific fallback covers Unix process groups and older Windows
    // environments where a descendant escaped before assignment.
    process_job.take();
    if let Some(pid) = child.id() {
        kill_process_tree_sync(pid);
    }
    let _ = child.start_kill();
    match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!("Failed waiting for server shutdown: {error}")),
        Err(_) => Err("Timed out waiting for server shutdown".to_string()),
    }
}

#[tauri::command]
pub async fn start_server(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();
    let observed = inspect_server_lifecycle(&app)?;
    let _operation = state.operation_gate.lock().await;
    let current = inspect_server_lifecycle(&app)?;

    match decide_start(observed, current) {
        StartDecision::AlreadyRunning => return Ok(()),
        StartDecision::ShareFailure => {
            let error = state
                .last_error
                .lock()
                .map_err(|lock_error| lock_error.to_string())?
                .clone()
                .unwrap_or_else(|| "Bundled server failed to start".to_string());
            return Err(error);
        }
        StartDecision::RejectStopping => {
            return Err("Bundled server is stopping".to_string());
        }
        StartDecision::Start => {}
    }

    state.begin_start()?;
    if let Ok(mut error) = state.last_error.lock() {
        *error = None;
    }
    let result = start_server_inner(app.clone()).await;
    match &result {
        Ok(()) => {
            state.set_phase(ServerPhase::Running)?;
        }
        Err(error) => {
            state.set_phase(ServerPhase::Error)?;
            if let Ok(mut last_error) = state.last_error.lock() {
                *last_error = Some(error.clone());
            }
            record_server_output(
                &app,
                "system",
                format!("\r\n[server start failed: {error}]\r\n"),
            );
        }
    }
    result
}

async fn start_server_inner(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();
    {
        let child = state.child.lock().map_err(|error| error.to_string())?;
        if child.is_some() {
            return Err("Bundled server state is inconsistent before startup".to_string());
        }
    }

    let config = config::load_config();
    let requested_port = config.port.unwrap_or(0);
    let data_dir = config::data_dir();
    let bootstrap_secret = generate_secret();
    record_server_output(
        &app,
        "system",
        format!("\r\n[server starting on loopback port {requested_port}]\r\n"),
    );

    let mut command = create_server_command(&app, requested_port, &data_dir)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start bundled server: {error}"))?;
    let process_job = assign_process_job(&child)?;
    if let Err(error) = send_startup_frame(&mut child, &bootstrap_secret).await {
        let _ = stop_child(child, Some(process_job), None).await;
        return Err(error);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Desktop server stdout was not piped".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Desktop server stderr was not piped".to_string())?;
    let (ready_tx, ready_rx) = oneshot::channel();
    spawn_stdout_reader(app.clone(), stdout, ready_tx);
    spawn_output_reader(app.clone(), "stderr", stderr);

    let ready = match tokio::time::timeout(SERVER_READY_TIMEOUT, ready_rx).await {
        Ok(Ok(Ok(ready))) => ready,
        Ok(Ok(Err(error))) => {
            let _ = stop_child(child, Some(process_job), None).await;
            return Err(error);
        }
        Ok(Err(_)) => {
            let _ = stop_child(child, Some(process_job), None).await;
            return Err("Desktop readiness channel closed unexpectedly".to_string());
        }
        Err(_) => {
            let _ = stop_child(child, Some(process_job), None).await;
            return Err("Timed out waiting for bundled server readiness".to_string());
        }
    };
    if ready.protocol != DESKTOP_BOOTSTRAP_PROTOCOL_VERSION {
        let _ = stop_child(child, Some(process_job), None).await;
        return Err(format!(
            "Bundled server uses unsupported desktop protocol {}",
            ready.protocol
        ));
    }

    *state.child.lock().map_err(|error| error.to_string())? = Some(child);
    *state
        .process_job
        .lock()
        .map_err(|error| error.to_string())? = Some(process_job);
    *state
        .bootstrap_secret
        .lock()
        .map_err(|error| error.to_string())? = Some(bootstrap_secret);
    *state.port.lock().map_err(|error| error.to_string())? = Some(ready.port);
    record_server_output(
        &app,
        "system",
        format!("\r\n[server ready on port {}]\r\n", ready.port),
    );
    Ok(())
}

#[tauri::command]
pub async fn stop_server(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();
    let _operation = state.operation_gate.lock().await;
    let current = inspect_server_lifecycle(&app)?;
    if current.phase == ServerPhase::Stopped {
        return Ok(());
    }
    state.set_phase(ServerPhase::Stopping)?;
    let child = state
        .child
        .lock()
        .map_err(|error| error.to_string())?
        .take();
    let process_job = state
        .process_job
        .lock()
        .map_err(|error| error.to_string())?
        .take();
    let secret = state
        .bootstrap_secret
        .lock()
        .map_err(|error| error.to_string())?
        .take();
    let port = state.port.lock().map_err(|error| error.to_string())?.take();

    let result = if let Some(child) = child {
        let graceful = port.zip(secret);
        stop_child(child, process_job, graceful).await
    } else {
        Ok(())
    };
    match &result {
        Ok(()) => {
            state.set_phase(ServerPhase::Stopped)?;
            record_server_output(&app, "system", "\r\n[server stopped]\r\n".to_string());
        }
        Err(error) => {
            state.set_phase(ServerPhase::Error)?;
            if let Ok(mut last_error) = state.last_error.lock() {
                *last_error = Some(error.clone());
            }
        }
    }
    result
}

fn inspect_server_lifecycle(app: &AppHandle) -> Result<ServerLifecycle, String> {
    let state = app.state::<ServerState>();
    let lifecycle = state.lifecycle()?;
    if lifecycle.phase != ServerPhase::Running {
        return Ok(lifecycle);
    }

    let exit_error = {
        let mut child = state.child.lock().map_err(|error| error.to_string())?;
        match child.as_mut() {
            None => Some("Bundled server process is missing".to_string()),
            Some(process) => match process.try_wait() {
                Ok(Some(status)) => {
                    *child = None;
                    Some(format!("Bundled server exited unexpectedly ({status})"))
                }
                Ok(None) => None,
                Err(error) => return Err(error.to_string()),
            },
        }
    };

    let Some(exit_error) = exit_error else {
        return Ok(lifecycle);
    };
    if let Ok(mut job) = state.process_job.lock() {
        *job = None;
    }
    if let Ok(mut secret) = state.bootstrap_secret.lock() {
        *secret = None;
    }
    if let Ok(mut port) = state.port.lock() {
        *port = None;
    }
    if let Ok(mut last_error) = state.last_error.lock() {
        *last_error = Some(exit_error.clone());
    }
    let lifecycle = state.set_phase(ServerPhase::Error)?;
    record_server_output(
        app,
        "system",
        format!("\r\n[server process failed: {exit_error}]\r\n"),
    );
    Ok(lifecycle)
}

#[tauri::command]
pub fn get_server_status(app: AppHandle) -> Result<String, String> {
    Ok(inspect_server_lifecycle(&app)?.phase.as_str().to_string())
}

pub(crate) fn get_server_attempt(app: &AppHandle) -> Result<u64, String> {
    Ok(inspect_server_lifecycle(app)?.attempt)
}

#[tauri::command]
pub fn get_server_error(app: AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<ServerState>();
    let error = state
        .last_error
        .lock()
        .map_err(|lock_error| lock_error.to_string())?;
    Ok(error.clone())
}

#[tauri::command]
pub async fn get_dashboard_url(app: AppHandle) -> Result<String, String> {
    get_dashboard_url_for_route(app, None).await
}

pub(crate) async fn get_dashboard_url_for_route(
    app: AppHandle,
    return_to: Option<&str>,
) -> Result<String, String> {
    let state = app.state::<ServerState>();
    let port = state
        .port
        .lock()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Bundled server is not ready".to_string())?;
    let secret = state
        .bootstrap_secret
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "Desktop bootstrap is unavailable".to_string())?;
    let base_url = format!("http://127.0.0.1:{port}");
    let response = reqwest::Client::new()
        .post(format!("{base_url}/desktop-bootstrap/mint"))
        .header("x-yep-desktop-bootstrap-secret", secret)
        .send()
        .await
        .map_err(|error| format!("Failed to mint desktop session: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Bundled server rejected desktop bootstrap ({})",
            response.status()
        ));
    }
    let minted = response
        .json::<MintBootstrapResponse>()
        .await
        .map_err(|error| format!("Invalid desktop bootstrap response: {error}"))?;
    let mut bootstrap_url =
        reqwest::Url::parse(&format!("{base_url}/desktop-bootstrap/{}", minted.code))
            .map_err(|error| format!("Invalid desktop bootstrap URL: {error}"))?;
    if let Some(return_to) = return_to {
        bootstrap_url
            .query_pairs_mut()
            .append_pair("return_to", return_to);
    }
    Ok(bootstrap_url.to_string())
}

#[tauri::command]
pub async fn get_server_output_buffer(app: AppHandle) -> Result<Vec<ServerOutputChunk>, String> {
    let state = app.state::<ServerState>();
    let output = state.output.lock().map_err(|error| error.to_string())?;
    Ok(output.snapshot())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        apply_desktop_server_env, decide_start, needs_windows_arm64_bun, redact_server_output,
        server_entry_candidates, windows_arm64_bun_candidates, ServerLifecycle, ServerPhase,
        StartDecision, DESKTOP_READY_PREFIX,
    };

    fn lifecycle(phase: ServerPhase, attempt: u64) -> ServerLifecycle {
        ServerLifecycle { phase, attempt }
    }

    #[test]
    fn sqlite_launch_mode_preserves_the_operator_override() {
        let mut command = tokio::process::Command::new("unused-test-command");
        apply_desktop_server_env(&mut command, 0, Path::new("test-data"));
        let expected = std::env::var_os("YEP_SQLITE").unwrap_or_else(|| "auto".into());
        let actual = command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == "YEP_SQLITE");
        assert_eq!(
            actual.and_then(|(_, value)| value),
            Some(expected.as_os_str())
        );
    }

    #[test]
    fn redacts_legacy_and_bootstrap_credentials() {
        let output = redact_server_output(
            "desktop_token=one DESKTOP_AUTH_TOKEN=two x-yep-desktop-bootstrap-secret:three"
                .to_string(),
        );
        assert_eq!(
            output,
            "desktop_token=[redacted] DESKTOP_AUTH_TOKEN=[redacted] x-yep-desktop-bootstrap-secret:[redacted]"
        );
    }

    #[test]
    fn readiness_prefix_contains_no_secret() {
        assert_eq!(DESKTOP_READY_PREFIX, "YEP_DESKTOP_READY ");
    }

    #[test]
    fn concurrent_start_callers_share_one_completed_attempt() {
        assert_eq!(
            decide_start(
                lifecycle(ServerPhase::Stopped, 0),
                lifecycle(ServerPhase::Error, 1),
            ),
            StartDecision::ShareFailure
        );
        assert_eq!(
            decide_start(
                lifecycle(ServerPhase::Starting, 1),
                lifecycle(ServerPhase::Error, 1),
            ),
            StartDecision::ShareFailure
        );
        assert_eq!(
            decide_start(
                lifecycle(ServerPhase::Starting, 1),
                lifecycle(ServerPhase::Running, 1),
            ),
            StartDecision::AlreadyRunning
        );
    }

    #[test]
    fn a_later_explicit_start_retries_after_failure() {
        assert_eq!(
            decide_start(
                lifecycle(ServerPhase::Error, 1),
                lifecycle(ServerPhase::Error, 1),
            ),
            StartDecision::Start
        );
    }

    #[test]
    fn a_launch_queued_during_shutdown_does_not_restart_the_server() {
        assert_eq!(
            decide_start(
                lifecycle(ServerPhase::Stopping, 1),
                lifecycle(ServerPhase::Stopped, 1),
            ),
            StartDecision::RejectStopping
        );
    }

    #[test]
    fn accepts_tauri_resource_and_windows_install_layouts() {
        let candidates = server_entry_candidates(Path::new("app-resources"));
        assert_eq!(
            candidates[0],
            Path::new("app-resources/server/dist/index.js")
        );
        assert_eq!(
            candidates[1],
            Path::new("app-resources/resources/server/dist/index.js")
        );

        let arm64_bun = windows_arm64_bun_candidates(Path::new("app-resources"));
        assert_eq!(
            arm64_bun[0],
            Path::new("app-resources/server/bun-windows-aarch64.exe")
        );
        assert_eq!(
            arm64_bun[1],
            Path::new("app-resources/resources/server/bun-windows-aarch64.exe")
        );
    }

    #[test]
    fn selects_native_arm64_bun_only_for_an_emulated_windows_process() {
        assert!(needs_windows_arm64_bun(true, 0xaa64));
        assert!(!needs_windows_arm64_bun(false, 0xaa64));
        assert!(!needs_windows_arm64_bun(true, 0x8664));
    }
}
