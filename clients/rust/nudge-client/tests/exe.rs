//! A server made on exe.dev and set up from the app, against a real `nudge serve`
//! (`packages/cli/dist`: `pnpm build` first) and a stand-in for exe.dev's API that starts that
//! server when told `new`, with the setup code it was given. The model is a stand-in Ollama.
//! Skipped, saying so, when `node`, the build or Ollama's port is missing.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nudge_client::protocol::*;
use nudge_client::*;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::time::timeout;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Answers HTTP requests on `listener` with `answer(method and path, body)`, one connection at a
/// time, each closed after its answer.
fn serve_http<F>(listener: TcpListener, answer: F)
where
    F: Fn(String, String) -> std::pin::Pin<Box<dyn Future<Output = (u16, String)> + Send>>
        + Send
        + Sync
        + 'static,
{
    let answer = Arc::new(answer);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let answer = answer.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut request = String::new();
                reader.read_line(&mut request).await.unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).await.unwrap();
                let first: Vec<&str> = request.split_whitespace().take(2).collect();
                let (status, text) =
                    answer(first.join(" "), String::from_utf8(body).unwrap()).await;
                let response = format!(
                    "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                    text.len()
                );
                reader
                    .into_inner()
                    .write_all(response.as_bytes())
                    .await
                    .unwrap();
            });
        }
    });
}

/// `nudge serve` in setup mode, in a data directory of its own, with `code`; its address.
async fn start_server(home: &Path, code: &str) -> (Child, String) {
    let mut process = Command::new("node")
        .arg(root().join("packages/cli/dist/main.js"))
        .args(["serve", "--port", "0"])
        .env("NUDGE_HOME", home)
        .env("NUDGE_SETUP_CODE", code)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("node runs");
    let mut lines = BufReader::new(process.stdout.take().unwrap()).lines();
    let url = timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some((url, _)) = line.trim().split_once("/setup#code=") {
                return url.to_owned();
            }
        }
        panic!("the server printed no setup link");
    })
    .await
    .expect("the server starts");
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    (process, url)
}

#[tokio::test]
async fn makes_a_server_on_exe_dev_and_sets_it_up_from_the_app() {
    if !root().join("packages/cli/dist/main.js").exists() {
        eprintln!("skipped: no packages/cli/dist; run `pnpm build` first");
        return;
    }
    if Command::new("node")
        .arg("--version")
        .output()
        .await
        .is_err()
    {
        eprintln!("skipped: no node");
        return;
    }
    // Ollama's port, answered here unless an Ollama runs: setup offers what it finds there.
    if let Ok(ollama) = TcpListener::bind("127.0.0.1:11434").await {
        serve_http(ollama, |_, _| {
            Box::pin(async { (200, r#"{"models":[{"name":"qwen3:4b"}]}"#.to_owned()) })
        });
    }

    let home = std::env::temp_dir().join(format!("nudge-exe-{}", &new_request_id()[..12]));
    let started: Arc<Mutex<Option<Child>>> = Arc::default();
    let commands: Arc<Mutex<Vec<String>>> = Arc::default();
    let exe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let exe_url = format!("http://{}", exe.local_addr().unwrap());
    {
        let (started, commands, home) = (started.clone(), commands.clone(), home.clone());
        serve_http(exe, move |request, body| {
            let (started, commands, home) = (started.clone(), commands.clone(), home.clone());
            Box::pin(async move {
                assert_eq!(request, "POST /exec");
                commands.lock().unwrap().push(body.clone());
                if body.starts_with("new ") {
                    let code = body
                        .split_whitespace()
                        .find_map(|part| part.strip_prefix("NUDGE_SETUP_CODE="))
                        .unwrap()
                        .to_owned();
                    let (process, url) = start_server(&home, &code).await;
                    *started.lock().unwrap() = Some(process);
                    return (200, format!(r#"{{"name":"robin","https_url":"{url}"}}"#));
                }
                if body.starts_with("rm ") {
                    started.lock().unwrap().take();
                }
                (200, "{}".to_owned())
            })
        });
    }

    let exe = ExeDev::with_base(&exe_url, "exe1.token").unwrap();
    let launched = exe
        .launch_server("robin", Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(launched.vm.name, "robin");
    {
        let commands = commands.lock().unwrap();
        assert!(
            commands[0].starts_with("new --json --name robin --image ghcr.io/lum1n/nudge:stable")
        );
        assert_eq!(
            commands[1..],
            ["share port robin 8787", "share set-public robin"]
        );
    }

    // The app sets it up with the code it gave the server.
    let server = launched.vm.url.clone();
    let info = setup_info(&server).await.unwrap();
    assert!(info.open);
    let local = info.local.first().expect("a model server on Ollama's port");
    let client = ClientInfo {
        name: "test".into(),
        platform: "rust".into(),
    };
    let wrong = check_setup_code(&server, "WRONG-WRONG-WRNG").await;
    assert_eq!(wrong.unwrap_err().status(), Some(401));
    check_setup_code(&server, &launched.code).await.unwrap();
    let done = set_up(
        &server,
        &SetupRequest {
            code: launched.code.clone(),
            client: client.clone(),
            assistant: SetupAssistant {
                name: "robin".into(),
                display_name: Some("Robin".into()),
            },
            model: ModelChoice {
                provider: "ollama".into(),
                model_id: local.models[0].clone(),
            },
            key: None,
            local: Some(local.id.clone()),
            you: SetupPerson {
                display_name: "Ann".into(),
            },
            public_url: Some(server.clone()),
            backups: Some(false),
        },
    )
    .await
    .unwrap();
    assert!(!setup_info(&server).await.unwrap().open);

    // As the owner: make an assistant someone else's home, and pair their app with it.
    let owner = ServerApi::new(
        &server,
        Arc::new(MemoryTokens::new(Some(done.server_token))),
    )
    .unwrap();
    assert_eq!(owner.info().await.unwrap().owner.player_id, done.player.id);
    let made = owner
        .create_assistant(&CreateAssistantRequest {
            name: "kari".into(),
            display_name: Some("Kari's".into()),
            first_player: Some(FirstPlayer {
                display_name: "Kari".into(),
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let pairing = made.pairing.expect("a pairing code");
    let kari = Api::new(&server, "kari", Arc::new(MemoryTokens::default())).unwrap();
    kari.pair(&pairing.code, client.clone()).await.unwrap();
    assert!(kari.me().await.unwrap().admin);
    let renamed = owner
        .update_assistant(
            "kari",
            &UpdateAssistantRequest {
                display_name: Some(Some("Kari".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(renamed.display_name, "Kari");
    assert!(
        owner
            .recovery_kit("correct horse")
            .await
            .unwrap()
            .contains("recovery-kit")
    );
    owner.delete_assistant("kari").await.unwrap();
    assert_eq!(
        owner
            .assistants()
            .await
            .unwrap()
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        ["robin"]
    );

    // A player token isn't a server token; signing in trades one for the other.
    let player = ServerApi::new(&server, Arc::new(MemoryTokens::default())).unwrap();
    assert_eq!(player.info().await.unwrap_err().status(), Some(401));
    player.sign_in("robin", &done.token, client).await.unwrap();
    assert_eq!(player.owners().await.unwrap().len(), 1);

    exe.delete("robin").await.unwrap();
    let _ = std::fs::remove_dir_all(&home);
}
