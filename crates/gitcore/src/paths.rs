//! Paths that go to git and to the user.

use std::io;
use std::path::{Path, PathBuf};

/// The canonical form of `path` (absolute, links resolved), in a form git can use.
///
/// On Windows `std::fs::canonicalize` returns a verbatim path (`\\?\C:\work\repo`). Git for
/// Windows cannot work with one (`git clone` into it fails with "Invalid argument"), so the prefix
/// is dropped whenever the path means the same without it (see `strip_verbatim`). On the other
/// systems this is `std::fs::canonicalize`.
///
/// Use it for every path that is stored, shown or given to git. A check that only compares two
/// canonical paths with each other can keep `std::fs::canonicalize`.
pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    let canon = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    let canon = match canon.to_str().and_then(strip_verbatim) {
        Some(plain) => PathBuf::from(plain),
        None => canon,
    };
    Ok(canon)
}

/// `\\?\C:\a\b` -> `C:\a\b` and `\\?\UNC\server\share\a` -> `\\server\share\a`. `None` when the
/// path is not verbatim, or when it would mean something else without the prefix: Windows only
/// reads a name that ends in a dot or a space, or a device name such as `NUL` or `COM1`, as a
/// file when the path is verbatim.
#[cfg(any(windows, test))]
fn strip_verbatim(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?;
    let (plain, names) = if let Some(unc) = rest.strip_prefix(r"UNC\") {
        // server\share\names...
        let mut parts = unc.splitn(3, '\\');
        let (server, share) = (parts.next()?, parts.next()?);
        if server.is_empty() || share.is_empty() {
            return None;
        }
        (format!(r"\\{unc}"), parts.next().unwrap_or(""))
    } else {
        let bytes = rest.as_bytes();
        let is_disk = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\';
        if !is_disk {
            return None;
        }
        (rest.to_string(), &rest[3..])
    };
    let safe = names
        .split('\\')
        .filter(|n| !n.is_empty())
        .all(is_plain_name);
    (safe && !names.contains('/')).then_some(plain)
}

/// A file name that Windows reads the same way with and without the verbatim prefix.
#[cfg(any(windows, test))]
fn is_plain_name(name: &str) -> bool {
    if name == "." || name == ".." || name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    // "NUL", "nul.txt" and "COM1 .log" are all the device.
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let stem = stem.to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
    };
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || numbered("COM")
        || numbered("LPT");
    !device
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(p: &str) -> Option<String> {
        strip_verbatim(p)
    }

    #[test]
    fn verbatim_disk_and_unc_paths_lose_the_prefix() {
        assert_eq!(
            plain(r"\\?\C:\Users\me\work repo"),
            Some(r"C:\Users\me\work repo".into())
        );
        assert_eq!(plain(r"\\?\d:\"), Some(r"d:\".into()));
        assert_eq!(
            plain(r"\\?\UNC\server\share\dir\repo"),
            Some(r"\\server\share\dir\repo".into())
        );
        assert_eq!(
            plain(r"\\?\UNC\server\share"),
            Some(r"\\server\share".into())
        );
        // names that only look like a device
        assert_eq!(
            plain(r"\\?\C:\console\com10\nullable.txt"),
            Some(r"C:\console\com10\nullable.txt".into())
        );
    }

    #[test]
    fn other_paths_are_left_alone() {
        assert_eq!(plain(r"C:\Users\me"), None);
        assert_eq!(plain("/home/me/repo"), None);
        assert_eq!(plain(r"\\server\share\x"), None);
        assert_eq!(
            plain(r"\\?\Volume{b75e2c83-0000-0000-0000-602f00000000}\x"),
            None
        );
        assert_eq!(plain(r"\\?\UNC\server"), None);
        assert_eq!(plain(r"\\?\C:"), None);
    }

    #[test]
    fn names_that_need_the_prefix_keep_it() {
        for p in [
            r"\\?\C:\work\nul",
            r"\\?\C:\work\NUL.txt",
            r"\\?\C:\work\com1\repo",
            r"\\?\C:\work\Lpt9.log",
            r"\\?\C:\work\aux .txt",
            r"\\?\C:\work\dot.\repo",
            r"\\?\C:\work\space \repo",
            r"\\?\C:\work\..\repo",
            r"\\?\C:\work/repo",
            r"\\?\UNC\server\share\con",
        ] {
            assert_eq!(plain(p), None, "{p}");
        }
    }

    #[test]
    fn canonicalize_gives_an_absolute_path_without_the_verbatim_prefix() {
        let dir = std::env::temp_dir();
        let canon = canonicalize(&dir).unwrap();
        assert!(canon.is_absolute());
        assert!(!canon.to_string_lossy().starts_with(r"\\?\"), "{canon:?}");
        assert!(canonicalize(&dir.join("deepgit-no-such-folder")).is_err());
    }
}
