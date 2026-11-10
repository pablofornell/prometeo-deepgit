//! Wire format between the helper process and the app: one request and one reply per
//! connection, each a frame of a 4-byte big-endian length followed by that many bytes of JSON.
//!
//! ```text
//! helper -> app   {"v":1,"token":"<64 hex>","prompt":"Username for 'https://github.com': ","hint":null}
//! app -> helper   {"answer":"alice"}      an answer
//! app -> helper   {"answer":null}         cancelled, timed out, unknown token or refused
//! ```
//!
//! `hint` is the value of `SSH_ASKPASS_PROMPT` (`confirm`, `none`) when ssh sets it.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Set to `1` in the environment of a git command that may call the helper.
pub const ENV_MARKER: &str = "DEEPGIT_ASKPASS";
/// Where the app listens: `unix:<path>` or `tcp:127.0.0.1:<port>`.
pub const ENV_ENDPOINT: &str = "DEEPGIT_ASKPASS_ENDPOINT";
/// The secret of this one git command. Passed through the environment only, never in argv.
pub const ENV_TOKEN: &str = "DEEPGIT_ASKPASS_TOKEN";
/// Set by OpenSSH 8.1 and later: `confirm` for yes/no questions, `none` for plain messages.
pub const ENV_SSH_PROMPT: &str = "SSH_ASKPASS_PROMPT";

pub const VERSION: u32 = 1;
/// Largest frame either side accepts.
pub const MAX_FRAME: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Request {
    pub v: u32,
    pub token: String,
    pub prompt: String,
    #[serde(default)]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Reply {
    pub answer: Option<String>,
}

fn too_big() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "frame too large")
}

/// The bytes of one frame.
pub fn encode<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    if body.len() > MAX_FRAME {
        return Err(too_big());
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

fn decode<T: for<'a> Deserialize<'a>>(body: &[u8]) -> io::Result<T> {
    serde_json::from_slice(body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Blocking read of one frame (the helper side).
pub fn read_frame<T: for<'a> Deserialize<'a>, R: Read>(r: &mut R) -> io::Result<T> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(too_big());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    decode(&body)
}

/// Blocking write of one frame (the helper side).
pub fn write_frame<T: Serialize, W: Write>(w: &mut W, value: &T) -> io::Result<()> {
    w.write_all(&encode(value)?)?;
    w.flush()
}

/// Async read of one frame (the app side).
pub async fn read_frame_async<T: for<'a> Deserialize<'a>, R: AsyncRead + Unpin>(
    r: &mut R,
) -> io::Result<T> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(too_big());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    decode(&body)
}

/// Async write of one frame (the app side).
pub async fn write_frame_async<T: Serialize, W: AsyncWrite + Unpin>(
    w: &mut W,
    value: &T,
) -> io::Result<()> {
    w.write_all(&encode(value)?).await?;
    w.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_round_trips() {
        let req = Request {
            v: VERSION,
            token: "abc".into(),
            prompt: "Password for 'https://a@b': ".into(),
            hint: None,
        };
        let bytes = encode(&req).unwrap();
        assert_eq!(
            u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize,
            bytes.len() - 4
        );
        let back: Request = read_frame(&mut &bytes[..]).unwrap();
        assert_eq!(back, req);
    }

    #[test]
    fn an_oversized_length_is_refused_before_allocating() {
        let mut bytes = (u32::MAX).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        let err = read_frame::<Reply, _>(&mut &bytes[..]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_truncated_frame_is_an_error() {
        let mut bytes = encode(&Reply { answer: None }).unwrap();
        bytes.pop();
        assert!(read_frame::<Reply, _>(&mut &bytes[..]).is_err());
    }

    #[test]
    fn garbage_json_is_an_error() {
        let mut bytes = 3u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"abc");
        assert!(read_frame::<Reply, _>(&mut &bytes[..]).is_err());
    }
}
