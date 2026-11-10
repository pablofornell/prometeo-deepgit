//! Where the app listens for helpers.
//!
//! - Unix: a domain socket `sock` (mode 0600) inside a private directory (mode 0700) under
//!   `$XDG_RUNTIME_DIR`, or the temp dir when that is not set, or `/tmp` when the temp dir is too
//!   long for a socket path (macOS: `sun_path` holds 104 bytes).
//! - Windows: a TCP port on `127.0.0.1` chosen by the system. Only the token protects it there
//!   (32 random bytes per command, valid until git exits). A named pipe would be better; the
//!   TCP form works on every platform and is what the tests use too.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
#[cfg(unix)]
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    #[cfg(unix)]
    Unix(PathBuf),
    Tcp(SocketAddr),
}

impl Endpoint {
    /// The text form that goes into `DEEPGIT_ASKPASS_ENDPOINT`.
    pub fn to_env(&self) -> String {
        match self {
            #[cfg(unix)]
            Endpoint::Unix(p) => format!("unix:{}", p.display()),
            Endpoint::Tcp(a) => format!("tcp:{a}"),
        }
    }

    pub fn parse(text: &str) -> Option<Endpoint> {
        #[cfg(unix)]
        if let Some(path) = text.strip_prefix("unix:") {
            return (!path.is_empty()).then(|| Endpoint::Unix(PathBuf::from(path)));
        }
        let addr: SocketAddr = text.strip_prefix("tcp:")?.parse().ok()?;
        // Never a remote address: the token must not leave the machine.
        addr.ip().is_loopback().then_some(Endpoint::Tcp(addr))
    }

    /// A loopback address with a free port for the `Tcp` form (the system picks the port).
    pub fn any_loopback() -> SocketAddr {
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0))
    }

    /// Blocking connection of the helper.
    pub fn connect(&self, timeout: Duration) -> io::Result<Connection> {
        match self {
            #[cfg(unix)]
            Endpoint::Unix(p) => Ok(Connection::Unix(std::os::unix::net::UnixStream::connect(
                p,
            )?)),
            Endpoint::Tcp(a) => Ok(Connection::Tcp(TcpStream::connect_timeout(a, timeout)?)),
        }
    }
}

/// A connected helper socket.
pub enum Connection {
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
    Tcp(TcpStream),
}

impl Connection {
    /// How long a read waits for the answer (the user may take minutes) and a write may block.
    pub fn set_timeouts(&self, read: Duration, write: Duration) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => {
                s.set_read_timeout(Some(read))?;
                s.set_write_timeout(Some(write))
            }
            Connection::Tcp(s) => {
                s.set_read_timeout(Some(read))?;
                s.set_write_timeout(Some(write))
            }
        }
    }
}

impl Read for Connection {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.read(buf),
            Connection::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for Connection {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.write(buf),
            Connection::Tcp(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Connection::Unix(s) => s.flush(),
            Connection::Tcp(s) => s.flush(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tcp_endpoints_round_trip_and_stay_on_loopback() {
        let e = Endpoint::parse("tcp:127.0.0.1:4455").unwrap();
        assert_eq!(e.to_env(), "tcp:127.0.0.1:4455");
        assert_eq!(Endpoint::parse("tcp:10.0.0.5:4455"), None);
        assert_eq!(Endpoint::parse("tcp:nonsense"), None);
        assert_eq!(Endpoint::parse(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn unix_endpoints_round_trip() {
        let e = Endpoint::parse("unix:/run/user/1000/x/sock").unwrap();
        assert_eq!(e.to_env(), "unix:/run/user/1000/x/sock");
        assert_eq!(Endpoint::parse("unix:"), None);
    }
}
