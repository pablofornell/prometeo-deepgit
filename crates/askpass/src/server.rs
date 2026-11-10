//! The listening side of the IPC (tokio). It only moves frames: reading a `Request`, awaiting the
//! handler and writing the `Reply`. Who may ask, and what is answered, is the handler's business
//! (see `broker`).

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::endpoint::Endpoint;
use crate::protocol::{read_frame_async, write_frame_async, Reply, Request, VERSION};

/// A helper must send its request within this time of connecting.
const REQUEST_WAIT: Duration = Duration::from_secs(10);

/// Answers one request: `Some(answer)` or `None` (cancel).
pub type Handler =
    Arc<dyn Fn(Request) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> + Send + Sync>;

/// A running listener. Dropping it stops accepting and removes the socket file.
pub struct Server {
    endpoint: Endpoint,
    task: JoinHandle<()>,
    #[cfg(unix)]
    dir: Option<std::path::PathBuf>,
}

impl Server {
    /// The platform default: a private Unix socket, or loopback TCP on Windows.
    pub async fn start(handler: Handler) -> io::Result<Server> {
        #[cfg(unix)]
        {
            Server::start_unix(handler, None).await
        }
        #[cfg(not(unix))]
        {
            Server::start_tcp(handler).await
        }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Loopback TCP on a port the system picks. Also used by the tests on every platform.
    pub async fn start_tcp(handler: Handler) -> io::Result<Server> {
        let listener = TcpListener::bind(Endpoint::any_loopback()).await?;
        let endpoint = Endpoint::Tcp(listener.local_addr()?);
        let task = tokio::spawn(async move {
            let mut conns = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            conns.spawn(serve(stream, handler.clone()));
                        }
                        Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                    },
                    Some(_) = conns.join_next(), if !conns.is_empty() => {}
                }
            }
        });
        Ok(Server {
            endpoint,
            task,
            #[cfg(unix)]
            dir: None,
        })
    }

    /// A socket in a new private directory under `base` (default `$XDG_RUNTIME_DIR`, else the
    /// temp dir). The directory is mode 0700 and the socket 0600; a peer of another user is
    /// dropped.
    #[cfg(unix)]
    pub async fn start_unix(
        handler: Handler,
        base: Option<&std::path::Path>,
    ) -> io::Result<Server> {
        use tokio::net::UnixListener;

        let dir = private_dir(base)?;
        let path = dir.join("askpass.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                let _ = std::fs::remove_dir(&dir);
                return Err(e);
            }
        };
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let endpoint = Endpoint::Unix(path);
        let task = tokio::spawn(async move {
            // SAFETY: geteuid(2) has no preconditions.
            let me = unsafe { libc::geteuid() };
            let mut conns = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => {
                            if stream.peer_cred().is_ok_and(|c| c.uid() == me) {
                                conns.spawn(serve(stream, handler.clone()));
                            }
                        }
                        Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                    },
                    Some(_) = conns.join_next(), if !conns.is_empty() => {}
                }
            }
        });
        Ok(Server {
            endpoint,
            task,
            dir: Some(dir),
        })
    }
}

impl Server {
    /// Stops accepting and removes the socket and its directory. Safe to call twice; the app calls
    /// it when it exits (state that Tauri manages is not dropped).
    pub fn shutdown(&self) {
        self.task.abort();
        #[cfg(unix)]
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_file(dir.join("askpass.sock"));
            let _ = std::fs::remove_dir(dir);
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// One connection: one request, one reply. Anything malformed closes the connection silently.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, handler: Handler) {
    let request =
        match tokio::time::timeout(REQUEST_WAIT, read_frame_async::<Request, _>(&mut stream)).await
        {
            Ok(Ok(r)) => r,
            _ => return,
        };
    let answer = if request.v == VERSION {
        handler(request).await
    } else {
        None
    };
    let _ = write_frame_async(&mut stream, &Reply { answer }).await;
}

// ------------------------------------------------------------------ private directory (Unix)

#[cfg(unix)]
const DIR_PREFIX: &str = "deepgit-askpass-";
/// `sun_path` holds 104 bytes on macOS and 108 on Linux.
#[cfg(unix)]
const MAX_SOCKET_PATH: usize = 100;

#[cfg(unix)]
fn random_hex(bytes: usize) -> io::Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Creates `<base>/deepgit-askpass-<pid>-<random>` with mode 0700 and removes the leftovers of
/// processes that no longer exist.
#[cfg(unix)]
fn private_dir(base: Option<&std::path::Path>) -> io::Result<std::path::PathBuf> {
    use std::os::unix::fs::DirBuilderExt;
    use std::path::PathBuf;

    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(b) = base {
        bases.push(b.to_path_buf());
    } else {
        if let Some(r) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
            if r.is_dir() {
                bases.push(r);
            }
        }
        bases.push(std::env::temp_dir());
        bases.push(PathBuf::from("/tmp"));
    }
    let mut last = io::Error::other("no directory for the askpass socket");
    for b in bases {
        let name = format!("{DIR_PREFIX}{}-{}", std::process::id(), random_hex(6)?);
        let dir = b.join(name);
        if dir.join("askpass.sock").as_os_str().len() > MAX_SOCKET_PATH {
            last = io::Error::other("socket path too long");
            continue;
        }
        sweep_stale(&b);
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Removes `deepgit-askpass-<pid>-*` directories of dead processes (a crash leaves them). Only an
/// empty directory or one holding just `askpass.sock` is touched.
#[cfg(unix)]
fn sweep_stale(base: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(rest) = name.to_str().and_then(|n| n.strip_prefix(DIR_PREFIX)) else {
            continue;
        };
        let Some(pid) = rest.split('-').next().and_then(|p| p.parse::<i32>().ok()) else {
            continue;
        };
        // SAFETY: kill(2) with signal 0 only checks that the process exists.
        let alive = unsafe { libc::kill(pid, 0) } == 0
            || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if alive {
            continue;
        }
        let dir = entry.path();
        let _ = std::fs::remove_file(dir.join("askpass.sock"));
        let _ = std::fs::remove_dir(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoint::Connection;
    use crate::protocol::{read_frame, write_frame};

    fn echo_handler() -> Handler {
        Arc::new(|req: Request| {
            Box::pin(async move { (req.token == "good").then(|| format!("echo:{}", req.prompt)) })
        })
    }

    async fn call(endpoint: Endpoint, token: &str, prompt: &str) -> io::Result<Reply> {
        let (token, prompt) = (token.to_string(), prompt.to_string());
        tokio::task::spawn_blocking(move || {
            let mut conn: Connection = endpoint.connect(Duration::from_secs(2))?;
            conn.set_timeouts(Duration::from_secs(5), Duration::from_secs(5))?;
            write_frame(
                &mut conn,
                &Request {
                    v: VERSION,
                    token,
                    prompt,
                    hint: None,
                    ppid: None,
                    ssh_port: None,
                },
            )?;
            read_frame(&mut conn)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn tcp_server_answers_and_refuses_over_loopback() {
        let server = Server::start_tcp(echo_handler()).await.unwrap();
        let ok = call(server.endpoint().clone(), "good", "hi").await.unwrap();
        assert_eq!(ok.answer.as_deref(), Some("echo:hi"));
        let no = call(server.endpoint().clone(), "bad", "hi").await.unwrap();
        assert_eq!(no.answer, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_socket_lives_in_a_private_directory() {
        use std::os::unix::fs::PermissionsExt;
        let base = tempfile::tempdir().unwrap();
        let server = Server::start_unix(echo_handler(), Some(base.path()))
            .await
            .unwrap();
        let Endpoint::Unix(path) = server.endpoint().clone() else {
            panic!("expected a unix endpoint");
        };
        let dir = path.parent().unwrap().to_path_buf();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let ok = call(server.endpoint().clone(), "good", "x").await.unwrap();
        assert_eq!(ok.answer.as_deref(), Some("echo:x"));
        server.shutdown();
        assert!(!dir.exists(), "shutdown removes the socket directory");
        server.shutdown(); // twice is fine
        drop(server);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stale_directories_of_dead_processes_are_swept() {
        let base = tempfile::tempdir().unwrap();
        // pid 2^31-2 does not exist on Linux or macOS.
        let stale = base.path().join(format!("{DIR_PREFIX}2147483646-abcdef"));
        std::fs::create_dir(&stale).unwrap();
        let alive = base
            .path()
            .join(format!("{DIR_PREFIX}{}-abcdef", std::process::id()));
        std::fs::create_dir(&alive).unwrap();
        let other = base.path().join("unrelated");
        std::fs::create_dir(&other).unwrap();
        let _server = Server::start_unix(echo_handler(), Some(base.path()))
            .await
            .unwrap();
        assert!(!stale.exists());
        assert!(alive.exists());
        assert!(other.exists());
    }

    #[tokio::test]
    async fn garbage_and_wrong_versions_get_no_answer() {
        let server = Server::start_tcp(echo_handler()).await.unwrap();
        let endpoint = server.endpoint().clone();
        let reply = tokio::task::spawn_blocking(move || {
            let mut conn = endpoint.connect(Duration::from_secs(2)).unwrap();
            conn.set_timeouts(Duration::from_secs(5), Duration::from_secs(5))
                .unwrap();
            write_frame(
                &mut conn,
                &Request {
                    v: 99,
                    token: "good".into(),
                    prompt: "x".into(),
                    hint: None,
                    ppid: None,
                    ssh_port: None,
                },
            )
            .unwrap();
            read_frame::<Reply, _>(&mut conn).unwrap()
        })
        .await
        .unwrap();
        assert_eq!(reply.answer, None);
    }
}
