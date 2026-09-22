use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Hard cap on how long an AI CLI may run before we give up and kill it.
/// Generous enough for a full-diff review, short enough to never hang forever.
const AI_TIMEOUT: Duration = Duration::from_secs(180);

/// Longer cap for the *conscious* review: with the PR's local clone present the
/// agent actually reads/greps the repo (an agentic loop with tool calls), which
/// legitimately takes minutes on a large PR. It runs in the background and
/// survives navigation, so a generous ceiling costs the user nothing — far
/// better than killing a valid run at 180s.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(420);

/// The right cap for a run: the long agentic one when it can read the repo,
/// the short one for diff-only / chat.
fn run_timeout(cwd: Option<&str>) -> Duration {
    if has_repo(cwd) {
        REVIEW_TIMEOUT
    } else {
        AI_TIMEOUT
    }
}

/// The effective timeout: the user's explicit Settings override (seconds) when
/// set and positive, else the provided smart default. With no override the auto
/// behavior stays byte-identical.
fn resolve_timeout(override_secs: Option<u64>, default: Duration) -> Duration {
    match override_secs {
        Some(s) if s > 0 => Duration::from_secs(s),
        _ => default,
    }
}

/// CLI binary for a provider id. Unknown ids fall back to Claude.
fn provider_bin(provider: &str) -> &str {
    match provider {
        "codex" => "codex",
        "gemini" => "gemini",
        _ => "claude",
    }
}

/// A one-shot run's final text, plus the model that answered — as reported by
/// the backend when it says (Claude), else the model that was asked for. `None`
/// means "the CLI's own default, unreported".
struct AiRun {
    text: String,
    model: Option<String>,
}

/// Dispatch a one-shot run to the selected backend and return its final text.
#[allow(clippy::too_many_arguments)]
async fn run_provider(
    provider: &str,
    prompt: &str,
    cwd: Option<&str>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    timeout_secs: Option<u64>,
    effort: Option<&str>,
) -> AppResult<AiRun> {
    let asked = model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(String::from);
    let text = match provider {
        "codex" => run_codex(prompt, cwd, model.as_deref(), timeout_secs).await?,
        "gemini" => run_gemini(prompt, cwd, model.as_deref(), timeout_secs).await?,
        "openai" => run_openai_compatible(prompt, base_url, model, api_key, timeout_secs).await?,
        _ => return run_claude(prompt, cwd, model.as_deref(), timeout_secs, effort).await,
    };
    Ok(AiRun { text, model: asked })
}

/// Run the AI CLI inside the PR's local clone (when one exists) so the agent can
/// actually grep/read the repo — not just the embedded diff. Ignored if the path
/// is missing or not a directory, so callers can always pass it optimistically.
/// True when `cwd` points at a real directory — the PR's local clone. Gates both
/// the working directory and whether the review may read the repo.
fn has_repo(cwd: Option<&str>) -> bool {
    cwd.is_some_and(|d| !d.is_empty() && std::path::Path::new(d).is_dir())
}

fn apply_cwd(cmd: &mut Command, cwd: Option<&str>) {
    if let Some(dir) = cwd {
        if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
            cmd.current_dir(dir);
        }
    }
}

/// PATH augmented with the locations CLIs are commonly installed to. A macOS app
/// launched from Finder/Dock inherits only a minimal PATH (`/usr/bin:/bin:…`),
/// so Homebrew's `/opt/homebrew/bin`, npm-global, and `~/.local/bin` are absent
/// — which makes an installed `claude`/`codex`/`gemini` look "not installed" and
/// breaks spawning it. We merge those dirs into whatever PATH we already have.
/// Computed once.
fn cli_path() -> &'static str {
    use std::sync::OnceLock;
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<String> = Vec::new();
        let add = |d: String, dirs: &mut Vec<String>| {
            if !d.is_empty() && !dirs.iter().any(|x| *x == d) {
                dirs.push(d);
            }
        };
        if let Ok(p) = std::env::var("PATH") {
            for d in p.split(':') {
                add(d.to_string(), &mut dirs);
            }
        }
        for d in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/opt/local/bin",
            "/opt/local/sbin",
            "/usr/bin",
            "/bin",
        ] {
            add(d.to_string(), &mut dirs);
        }
        if let Ok(home) = std::env::var("HOME") {
            for d in [
                ".local/bin",
                ".cargo/bin",
                ".bun/bin",
                ".deno/bin",
                ".npm-global/bin",
                ".claude/local",
            ] {
                add(format!("{home}/{d}"), &mut dirs);
            }
        }
        dirs.join(":")
    })
}

/// A `Command` for a CLI tool, with PATH widened to the usual install dirs so it
/// resolves even when the app was launched from Finder/Dock (see `cli_path`).
/// Shared with `git`/`gh` spawns in the git & auth commands — a GUI launch
/// hides Homebrew's bin dir, which is why an installed `gh` looked "not found".
pub(crate) fn cli_command(bin: &str) -> Command {
    let mut cmd = Command::new(bin);
    cmd.env("PATH", cli_path());
    cmd
}

/// Append the CLI's model flag (`--model` / `-m`) when a non-empty model
/// override is configured. Empty/absent → the CLI keeps its own default.
fn add_model(cmd: &mut Command, flag: &str, model: Option<&str>) {
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        cmd.arg(flag).arg(m);
    }
}

/// Levels `claude --effort` accepts. Anything else is dropped rather than
/// passed through, so a stale setting can't fail every run.
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// The effort level to actually send: a known level, or `None` for the CLI's
/// own default.
fn effort_level(effort: Option<&str>) -> Option<&str> {
    effort.map(str::trim).filter(|e| EFFORTS.contains(e))
}

/// Append Claude's `--effort` flag when a known level is configured.
fn add_effort(cmd: &mut Command, effort: Option<&str>) {
    if let Some(e) = effort_level(effort) {
        cmd.arg("--effort").arg(e);
    }
}

/// The model that did the bulk of a Claude run, from the `modelUsage` map in
/// `--output-format json|stream-json` results. A run can touch more than one
/// model (a small helper model runs alongside the main one), so pick the one
/// that processed the most tokens.
fn main_model(result: &serde_json::Value) -> Option<String> {
    let usage = result.get("modelUsage")?.as_object()?;
    let tokens = |u: &serde_json::Value| -> u64 {
        ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]
            .iter()
            .filter_map(|k| u.get(*k).and_then(serde_json::Value::as_u64))
            .sum()
    };
    usage.iter().max_by_key(|(_, u)| tokens(u)).map(|(name, _)| name.clone())
}

/// A parsed `claude -p --output-format json` result: the answer text, whether
/// the CLI flagged the run as failed, and the model that answered. `None` when
/// stdout isn't that JSON shape — the caller then treats it as plain text.
fn parse_claude_json(stdout: &str) -> Option<(String, bool, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    if v.get("type")?.as_str()? != "result" {
        return None;
    }
    let text = v.get("result").and_then(serde_json::Value::as_str).unwrap_or("").trim().to_string();
    let is_error = v.get("is_error").and_then(serde_json::Value::as_bool).unwrap_or(false);
    Some((text, is_error, main_model(&v)))
}

/// Turn a CLI failure (or a success with no output) into a *helpful* error.
/// Well-known stderr signatures — not-signed-in, rate-limit/quota, unknown
/// model, context-length — become a friendly one-liner so the real cause
/// reaches the user; otherwise the trailing stderr (capped) is shown, instead
/// of a raw multi-KB dump or a silent empty parse failure downstream.
fn cli_error(name: &str, code: &str, stderr: &str) -> AppError {
    let low = stderr.to_lowercase();
    let msg = if low.contains("not logged in")
        || low.contains("authenticat")
        || low.contains("please run")
        || (low.contains("api key") && (low.contains("missing") || low.contains("not ")))
    {
        format!("{name} isn't signed in — run `{name}` once in a terminal to log in, then retry.")
    } else if low.contains("rate limit")
        || low.contains("quota")
        || low.contains("429")
        || low.contains("overloaded")
    {
        format!("{name} hit a rate limit or quota — wait a moment and try again.")
    } else if low.contains("model")
        && (low.contains("not found")
            || low.contains("unknown")
            || low.contains("invalid")
            || low.contains("does not exist")
            || low.contains("not supported"))
    {
        format!("The model set in Settings → AI review isn't valid for {name}.")
    } else if (low.contains("context") && low.contains("length"))
        || low.contains("too many tokens")
        || low.contains("maximum context")
        || low.contains("prompt is too long")
    {
        "This PR is too large for the model's context window — try a smaller PR.".to_string()
    } else if stderr.is_empty() {
        format!("{name} produced no output (exit {code}).")
    } else {
        // Errors sit at the END of a noisy stderr — keep the tail.
        let tail: String = stderr
            .chars()
            .rev()
            .take(300)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{name} exited {code}: {tail}")
    };
    AppError::Other(msg)
}

/// The CLI's own failure text. Some CLIs — Claude among them — print the reason
/// on STDOUT and leave stderr EMPTY, so fall back to stdout: otherwise the real
/// cause (an expired login, an invalid model) is swallowed and the user is left
/// with the useless generic "produced no output".
fn cli_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr).trim().to_string();
    if !err.is_empty() {
        return err;
    }
    String::from_utf8_lossy(stdout).trim().to_string()
}

/// Exit code as a bare number ("1"). `ExitStatus`'s Display is "exit status: 1",
/// which would render as "exit exit status: 1" in the messages above.
fn exit_code(status: &std::process::ExitStatus) -> String {
    status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string())
}

/// True when the selected provider's CLI is available in PATH. The OpenAI-
/// compatible provider has no binary — it's gated on a configured base URL in
/// the UI — so report it as available here.
#[tauri::command]
pub async fn ai_available(provider: String) -> bool {
    if provider == "openai" {
        return true;
    }
    cli_command(provider_bin(&provider))
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a one-shot review/answer with the chosen provider and return the
/// final message as text. The prompt is fully self-contained (it embeds the
/// diff), so the agents never need to touch the filesystem.
#[tauri::command]
pub async fn ai_review(
    provider: String,
    prompt: String,
    cwd: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    timeout_secs: Option<u64>,
    effort: Option<String>,
) -> AppResult<String> {
    run_provider(
        &provider,
        &prompt,
        cwd.as_deref(),
        base_url,
        model,
        api_key,
        timeout_secs,
        effort.as_deref(),
    )
    .await
    .map(|r| r.text)
}

/// Run a review in the BACKGROUND, keyed by `key` (the PR). Returns immediately;
/// the result is delivered via an `ai:done` event `{ key, ok, output|error,
/// provider, headSha, model?, effort? }` — `model` is the one that answered
/// when known, `effort` the level that was sent (absent = the CLI's default). Because the work runs in a Rust task (not tied to the
/// webview), it survives navigating away and webview refreshes — the event fires
/// whenever it finishes and the reloaded UI's listener picks it up. `ai_inflight`
/// lets the UI restore the "generating" state on mount.
#[tauri::command]
pub async fn ai_review_bg(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    provider: String,
    prompt: String,
    head_sha: Option<String>,
    cwd: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    timeout_secs: Option<u64>,
    effort: Option<String>,
) -> AppResult<()> {
    {
        let mut set = state.ai_inflight.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if set.contains(&key) {
            return Ok(()); // already generating for this PR — don't double-spawn
        }
        set.insert(key.clone());
    }
    let inflight = state.ai_inflight.clone();
    let tasks = state.ai_tasks.clone();
    let head_sha = head_sha.unwrap_or_default();
    let task_key = key.clone();
    let handle = tauri::async_runtime::spawn(async move {
        // Only Claude takes an effort level; don't report one the run never used.
        let effort = match provider.as_str() {
            "codex" | "gemini" | "openai" => None,
            _ => effort_level(effort.as_deref()).map(String::from),
        };
        let result = run_provider(
            &provider,
            &prompt,
            cwd.as_deref(),
            base_url,
            model,
            api_key,
            timeout_secs,
            effort.as_deref(),
        )
        .await;
        if let Ok(mut set) = inflight.lock() {
            set.remove(&task_key);
        }
        if let Ok(mut t) = tasks.lock() {
            t.remove(&task_key);
        }
        let payload = match result {
            Ok(run) => serde_json::json!({
                "key": task_key, "ok": true, "output": run.text,
                "provider": provider, "headSha": head_sha,
                "model": run.model, "effort": effort,
            }),
            Err(e) => serde_json::json!({
                "key": task_key, "ok": false, "error": e.to_string(),
                "provider": provider, "headSha": head_sha,
            }),
        };
        let _ = app.emit("ai:done", payload);
    });
    if let Ok(mut t) = state.ai_tasks.lock() {
        t.insert(key, handle);
    }
    Ok(())
}

/// Cancel a running guided-tour generation. Aborting the task drops the AI CLI
/// child (kill_on_drop), so the process is stopped; emits `ai:done {canceled}`.
#[tauri::command]
pub fn ai_cancel(app: AppHandle, state: State<'_, AppState>, key: String) {
    let was_running = {
        let mut t = state.ai_tasks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match t.remove(&key) {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    };
    if let Ok(mut s) = state.ai_inflight.lock() {
        s.remove(&key);
    }
    if was_running {
        let _ = app.emit(
            "ai:done",
            serde_json::json!({ "key": key, "ok": false, "error": "Canceled", "canceled": true }),
        );
    }
}

/// PR keys whose guided-tour generation is currently running in the background.
#[tauri::command]
pub fn ai_inflight(state: State<'_, AppState>) -> Vec<String> {
    state
        .ai_inflight
        .lock()
        .map(|s| s.iter().cloned().collect())
        .unwrap_or_default()
}

/// Feed `prompt` to a freshly-spawned child's stdin on a detached task. Writing
/// concurrently with the child's own run avoids a deadlock when the prompt is
/// larger than the OS pipe buffer and the child only drains stdin as it works;
/// dropping the write handle at the end signals EOF.
fn feed_stdin(child: &mut tokio::process::Child, prompt: &str) {
    if let Some(mut sin) = child.stdin.take() {
        let bytes = prompt.as_bytes().to_vec();
        tauri::async_runtime::spawn(async move {
            let _ = sin.write_all(&bytes).await;
            let _ = sin.shutdown().await;
        });
    }
}

async fn run_claude(
    prompt: &str,
    cwd: Option<&str>,
    model: Option<&str>,
    timeout_secs: Option<u64>,
    effort: Option<&str>,
) -> AppResult<AiRun> {
    let mut cmd = cli_command("claude");
    // Prompt goes over stdin, not argv: a large PR context could otherwise hit
    // the OS arg-length limit, while stdin has no such ceiling. `claude -p`
    // reads the query from stdin when no positional prompt is given.
    // JSON rather than text output: the result also names the model that
    // actually answered, which a blank Model setting otherwise hides.
    cmd.arg("-p")
        .arg("--output-format")
        .arg("json")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    add_model(&mut cmd, "--model", model);
    add_effort(&mut cmd, effort);
    // With the PR's local clone present, let the review READ the repo
    // (read-only — no edits, no shell) so it can resolve its own questions from
    // the actual code instead of reasoning off the diff alone. Without a clone
    // there's nothing local to explore, so we leave it diff-only.
    if has_repo(cwd) {
        cmd.arg("--allowedTools").arg("Read Grep Glob LS");
    }
    apply_cwd(&mut cmd, cwd);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn claude: {e}")))?;
    feed_stdin(&mut child, prompt);

    let timeout = resolve_timeout(timeout_secs, run_timeout(cwd));
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| AppError::Other(format!("wait claude: {e}")))?,
        // On timeout the dropped future kills the child (kill_on_drop).
        Err(_) => {
            return Err(AppError::Other(format!(
                "Claude took longer than {}s and was stopped. Try again, or pick a smaller PR.",
                timeout.as_secs()
            )))
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Unparseable stdout is taken as plain text, so a CLI that stops speaking
    // this JSON shape degrades to "model unknown" instead of failing the run.
    let parsed = parse_claude_json(&stdout);
    // The failure reason lives in `result`, not in the raw JSON — which would
    // otherwise trip `cli_error`'s "model" check on the `modelUsage` key.
    let detail = || match &parsed {
        Some((text, _, _)) if !text.is_empty() => text.clone(),
        _ => cli_detail(&output.stdout, &output.stderr),
    };
    if !output.status.success() {
        return Err(cli_error("claude", &exit_code(&output.status), &detail()));
    }
    let (text, is_error, model) = match &parsed {
        Some((text, is_error, model)) => (text.clone(), *is_error, model.clone()),
        None => (stdout.trim().to_string(), false, None),
    };
    if is_error || text.is_empty() {
        return Err(cli_error("claude", "0", &detail()));
    }
    Ok(AiRun { text, model })
}

/// Run the Claude CLI in *apply* mode — full edit + shell access — inside `cwd`,
/// so the agent can actually implement a change (bump a dependency, update the
/// lockfile, run the build/tests and fix fallout). Powers the Dependabot AI-fix
/// flow. Long timeout: install + build + test can take several minutes.
///
/// `--dangerously-skip-permissions` lets it edit files and run shell commands
/// without prompting; only ever pointed at the user's own local clone.
pub async fn apply_with_claude(prompt: &str, cwd: &str) -> AppResult<String> {
    const APPLY_TIMEOUT: Duration = Duration::from_secs(600);
    let mut cmd = cli_command("claude");
    cmd.arg("-p")
        .arg(prompt)
        .arg("--dangerously-skip-permissions")
        .arg("--output-format")
        .arg("text")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_cwd(&mut cmd, Some(cwd));
    let child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn claude: {e}")))?;
    let output = match tokio::time::timeout(APPLY_TIMEOUT, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| AppError::Other(format!("wait claude: {e}")))?,
        Err(_) => {
            return Err(AppError::Other(
                "The AI fix took longer than 10 minutes and was stopped.".into(),
            ))
        }
    };
    if !output.status.success() {
        return Err(AppError::Other(format!(
            "claude exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn run_codex(
    prompt: &str,
    cwd: Option<&str>,
    model: Option<&str>,
    timeout_secs: Option<u64>,
) -> AppResult<String> {
    // Write only the agent's final message to a temp file so we get clean
    // markdown back instead of the interleaved progress log on stdout.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut out_path = std::env::temp_dir();
    out_path.push(format!("reviewly-codex-{nanos}.md"));

    // Pass the prompt over stdin (`-`): avoids OS arg-length limits and codex's
    // "reading additional input from stdin" hang when a prompt arg is given.
    let mut cmd = cli_command("codex");
    cmd.arg("exec")
        .arg("--skip-git-repo-check")
        .arg("-s")
        .arg("read-only")
        .arg("--output-last-message")
        .arg(&out_path);
    add_model(&mut cmd, "-m", model); // codex needs -m before the `-` stdin arg
    cmd.arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_cwd(&mut cmd, cwd);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn codex: {e}")))?;

    feed_stdin(&mut child, prompt);

    let timeout = resolve_timeout(timeout_secs, run_timeout(cwd));
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| AppError::Other(format!("wait codex: {e}")))?,
        Err(_) => {
            let _ = tokio::fs::remove_file(&out_path).await;
            return Err(AppError::Other(format!(
                "Codex took longer than {}s and was stopped. Try again, or pick a smaller PR.",
                timeout.as_secs()
            )));
        }
    };

    if !output.status.success() {
        let _ = tokio::fs::remove_file(&out_path).await;
        return Err(cli_error(
            "codex",
            &exit_code(&output.status),
            &cli_detail(&output.stdout, &output.stderr),
        ));
    }

    let text = tokio::fs::read_to_string(&out_path)
        .await
        .unwrap_or_else(|_| String::from_utf8_lossy(&output.stdout).to_string());
    let _ = tokio::fs::remove_file(&out_path).await;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(cli_error(
            "codex",
            &exit_code(&output.status),
            &cli_detail(&output.stdout, &output.stderr),
        ));
    }
    Ok(text)
}

/// Gemini CLI in non-interactive mode (`gemini -p`). Drop-in like Claude/Codex;
/// runs inside the PR clone when present so it can read the repo.
async fn run_gemini(
    prompt: &str,
    cwd: Option<&str>,
    model: Option<&str>,
    timeout_secs: Option<u64>,
) -> AppResult<String> {
    let mut cmd = cli_command("gemini");
    cmd.arg("-p")
        .arg(prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    add_model(&mut cmd, "-m", model);
    apply_cwd(&mut cmd, cwd);
    let child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn gemini: {e}")))?;
    let timeout = resolve_timeout(timeout_secs, run_timeout(cwd));
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| AppError::Other(format!("wait gemini: {e}")))?,
        Err(_) => {
            return Err(AppError::Other(format!(
                "Gemini took longer than {}s and was stopped. Try again, or pick a smaller PR.",
                timeout.as_secs()
            )))
        }
    };
    if !output.status.success() {
        return Err(cli_error(
            "gemini",
            &exit_code(&output.status),
            &cli_detail(&output.stdout, &output.stderr),
        ));
    }
    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if out.is_empty() {
        return Err(cli_error(
            "gemini",
            "0",
            &cli_detail(&output.stdout, &output.stderr),
        ));
    }
    Ok(out)
}

/// Any OpenAI-compatible chat endpoint: Ollama / LM Studio (local), OpenRouter,
/// DeepSeek, Groq, etc. Pure HTTP — no CLI, no repo access (reasons over the
/// embedded diff only). `base_url` is the API root (…/v1); the key is optional.
async fn run_openai_compatible(
    prompt: &str,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    timeout_secs: Option<u64>,
) -> AppResult<String> {
    let base = base_url.unwrap_or_default();
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Other(
            "No endpoint configured — set a Base URL in Settings → AI review.".into(),
        ));
    }
    let model = model.unwrap_or_default();
    let model = model.trim();
    if model.is_empty() {
        return Err(AppError::Other(
            "No model configured — set a Model in Settings → AI review.".into(),
        ));
    }

    let url = format!("{base}/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
        "temperature": 0.2,
    });
    let client = reqwest::Client::builder()
        .timeout(resolve_timeout(timeout_secs, AI_TIMEOUT))
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))?;
    let mut req = client.post(&url).json(&body);
    if let Some(k) = api_key.as_deref() {
        if !k.trim().is_empty() {
            req = req.bearer_auth(k.trim());
        }
    }

    let res = req
        .send()
        .await
        .map_err(|e| AppError::Other(format!("request to {base} failed: {e}")))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message").cloned().or_else(|| Some(e.clone())))
                    .map(|m| m.to_string())
            })
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(AppError::Other(format!(
            "{base} returned {}: {msg}",
            status.as_u16()
        )));
    }

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("bad JSON from endpoint: {e}")))?;
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string());
    match content {
        Some(c) if !c.is_empty() => Ok(c),
        _ => Err(AppError::Other("Endpoint returned no message content.".into())),
    }
}

/// Stream a one-shot answer token-by-token. Emits `ai:chunk { key, delta }` as
/// text arrives and a final `ai:complete { key, ok, output, costUsd?, error? }`.
/// De-duped + cancelable via the same inflight/task maps as `ai_review_bg`.
#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    provider: String,
    prompt: String,
    cwd: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    timeout_secs: Option<u64>,
    effort: Option<String>,
) -> AppResult<()> {
    {
        let mut set = state.ai_inflight.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if set.contains(&key) {
            return Ok(());
        }
        set.insert(key.clone());
    }
    let inflight = state.ai_inflight.clone();
    let tasks = state.ai_tasks.clone();
    let task_key = key.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = stream_provider(
            &app,
            &task_key,
            &provider,
            &prompt,
            cwd.as_deref(),
            base_url,
            model,
            api_key,
            timeout_secs,
            effort.as_deref(),
        )
        .await;
        if let Ok(mut s) = inflight.lock() {
            s.remove(&task_key);
        }
        if let Ok(mut t) = tasks.lock() {
            t.remove(&task_key);
        }
        let payload = match result {
            Ok((text, cost)) => serde_json::json!({
                "key": task_key, "ok": true, "output": text, "costUsd": cost,
            }),
            Err(e) => serde_json::json!({
                "key": task_key, "ok": false, "error": e.to_string(),
            }),
        };
        let _ = app.emit("ai:complete", payload);
    });
    if let Ok(mut t) = state.ai_tasks.lock() {
        t.insert(key, handle);
    }
    Ok(())
}

/// Returns (full_text, cost_usd). Claude and OpenAI-compatible stream live;
/// codex/gemini have no clean token stream, so they run once and the whole
/// result is emitted as a single chunk.
#[allow(clippy::too_many_arguments)]
async fn stream_provider(
    app: &AppHandle,
    key: &str,
    provider: &str,
    prompt: &str,
    cwd: Option<&str>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    timeout_secs: Option<u64>,
    effort: Option<&str>,
) -> AppResult<(String, Option<f64>)> {
    match provider {
        "claude" => {
            stream_claude(app, key, prompt, cwd, model.as_deref(), timeout_secs, effort).await
        }
        "openai" => stream_openai(app, key, prompt, base_url, model, api_key, timeout_secs).await,
        other => {
            let text = run_provider(other, prompt, cwd, base_url, model, api_key, timeout_secs, None)
                .await?
                .text;
            let _ = app.emit("ai:chunk", serde_json::json!({ "key": key, "delta": text }));
            Ok((text, None))
        }
    }
}

async fn stream_claude(
    app: &AppHandle,
    key: &str,
    prompt: &str,
    cwd: Option<&str>,
    model: Option<&str>,
    timeout_secs: Option<u64>,
    effort: Option<&str>,
) -> AppResult<(String, Option<f64>)> {
    let mut cmd = cli_command("claude");
    // Prompt over stdin (not argv) so a large PR context can't hit the OS
    // arg-length limit — same as run_claude. Streaming stdout is unaffected.
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    add_model(&mut cmd, "--model", model);
    add_effort(&mut cmd, effort);
    apply_cwd(&mut cmd, cwd);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn claude: {e}")))?;
    feed_stdin(&mut child, prompt);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("claude: no stdout".into()))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut full = String::new();
    // Non-stream-json stdout lines: Claude prints failures (expired login, bad
    // model) as plain text there, so keep them to explain an empty run.
    let mut noise = String::new();
    let mut cost: Option<f64> = None;

    let read = async {
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| AppError::Other(format!("read claude: {e}")))?
        {
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                if noise.len() < 1000 {
                    noise.push_str(line.trim());
                    noise.push('\n');
                }
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("stream_event") => {
                    let ev = v.get("event");
                    let is_delta = ev.and_then(|e| e.get("type")).and_then(|t| t.as_str())
                        == Some("content_block_delta");
                    if is_delta {
                        let delta = ev.and_then(|e| e.get("delta"));
                        let is_text = delta.and_then(|d| d.get("type")).and_then(|t| t.as_str())
                            == Some("text_delta");
                        if is_text {
                            if let Some(txt) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str())
                            {
                                full.push_str(txt);
                                let _ = app
                                    .emit("ai:chunk", serde_json::json!({ "key": key, "delta": txt }));
                            }
                        }
                    }
                }
                Some("result") => {
                    if let Some(r) = v.get("result").and_then(|r| r.as_str()) {
                        if !r.is_empty() {
                            full = r.to_string();
                        }
                    }
                    cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
                }
                _ => {}
            }
        }
        Ok::<(), AppError>(())
    };

    let cap = resolve_timeout(timeout_secs, AI_TIMEOUT);
    match tokio::time::timeout(cap, read).await {
        Ok(r) => r?,
        Err(_) => {
            return Err(AppError::Other(format!(
                "Claude took longer than {}s and was stopped. Try again, or pick a smaller PR.",
                cap.as_secs()
            )))
        }
    }
    let status = child.wait().await.ok();
    if full.is_empty() {
        let code = status.map(|s| exit_code(&s)).unwrap_or_else(|| "?".to_string());
        return Err(cli_error("claude", &code, noise.trim()));
    }
    Ok((full, cost))
}

async fn stream_openai(
    app: &AppHandle,
    key: &str,
    prompt: &str,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    timeout_secs: Option<u64>,
) -> AppResult<(String, Option<f64>)> {
    let base = base_url.unwrap_or_default();
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Other(
            "No endpoint configured — set a Base URL in Settings → AI review.".into(),
        ));
    }
    let model = model.unwrap_or_default();
    let model = model.trim();
    if model.is_empty() {
        return Err(AppError::Other(
            "No model configured — set a Model in Settings → AI review.".into(),
        ));
    }
    let url = format!("{base}/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": true,
        "temperature": 0.2,
    });
    let client = reqwest::Client::builder()
        .timeout(resolve_timeout(timeout_secs, AI_TIMEOUT))
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))?;
    let mut req = client.post(&url).json(&body);
    if let Some(k) = api_key.as_deref() {
        if !k.trim().is_empty() {
            req = req.bearer_auth(k.trim());
        }
    }
    let mut res = req
        .send()
        .await
        .map_err(|e| AppError::Other(format!("request to {base} failed: {e}")))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "{base} returned {status}: {}",
            text.chars().take(300).collect::<String>()
        )));
    }

    let mut full = String::new();
    let mut buf = String::new();
    // Server-Sent Events: lines of `data: {json}` ending with `data: [DONE]`.
    while let Some(bytes) = res
        .chunk()
        .await
        .map_err(|e| AppError::Other(format!("stream error: {e}")))?
    {
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !delta.is_empty() {
                        full.push_str(delta);
                        let _ =
                            app.emit("ai:chunk", serde_json::json!({ "key": key, "delta": delta }));
                    }
                }
            }
        }
    }
    if full.is_empty() {
        return Err(AppError::Other("Endpoint returned no message content.".into()));
    }
    Ok((full, None))
}

#[tauri::command]
pub fn path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_json_reports_the_main_model() {
        // Trimmed from a real `claude -p --output-format json` run: a helper
        // model ran alongside, with more OUTPUT tokens but far less work.
        let out = r#"{"type":"result","is_error":false,"result":" ok ","modelUsage":{
            "claude-haiku-4-5-20251001":{"inputTokens":897,"outputTokens":9},
            "claude-opus-5-5[1m]":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":21188,"cacheCreationInputTokens":14069}}}"#;
        let (text, is_error, model) = parse_claude_json(out).unwrap();
        assert_eq!(text, "ok");
        assert!(!is_error);
        assert_eq!(model.as_deref(), Some("claude-opus-5-5[1m]"));
    }

    #[test]
    fn claude_json_error_and_missing_usage() {
        let out = r#"{"type":"result","is_error":true,"result":"Not logged in"}"#;
        let (text, is_error, model) = parse_claude_json(out).unwrap();
        assert_eq!(text, "Not logged in");
        assert!(is_error);
        assert_eq!(model, None);
    }

    #[test]
    fn non_json_stdout_is_not_parsed() {
        assert!(parse_claude_json("plain answer").is_none());
        assert!(parse_claude_json(r#"{"layers":[]}"#).is_none());
    }

    #[test]
    fn effort_accepts_only_known_levels() {
        assert_eq!(effort_level(Some(" high ")), Some("high"));
        assert_eq!(effort_level(Some("xhigh")), Some("xhigh"));
        assert_eq!(effort_level(Some("")), None);
        assert_eq!(effort_level(Some("extreme")), None);
        assert_eq!(effort_level(None), None);
    }
}
