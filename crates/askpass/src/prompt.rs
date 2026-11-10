//! Reads the text git and ssh pass to the helper and tells what is being asked.
//!
//! The formats (locale `C`; the runner sets `LC_ALL=C`):
//!
//! - git, HTTPS: `Username for 'https://github.com': ` and `Password for 'https://alice@github.com': `
//! - ssh, key: `Enter passphrase for key '/home/a/.ssh/id_ed25519': ` (older ssh and ssh-add: no
//!   quotes, no `key`; ssh-add asks again with `Bad passphrase, try again for /path:`)
//! - ssh, password: `alice@host's password: `
//! - ssh, smart card: `Enter PIN for 'label': `
//! - ssh, host key: `The authenticity of host 'h (1.2.3.4)' can't be established. ... Are you sure
//!   you want to continue connecting (yes/no/[fingerprint])? `

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptKind {
    Username,
    Password,
    Passphrase,
    Pin,
    Hostkey,
    Unknown,
}

impl PromptKind {
    /// The answer is a secret (masked in the dialog, saved only in the key store).
    pub fn is_secret(self) -> bool {
        matches!(
            self,
            PromptKind::Password | PromptKind::Passphrase | PromptKind::Pin
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub kind: PromptKind,
    /// The text as git or ssh sent it.
    pub text: String,
    /// `https://github.com` (no user, no path) for HTTPS, `alice@host` for an ssh password,
    /// the host name of a host-key question.
    pub host: Option<String>,
    pub user: Option<String>,
    pub key_path: Option<String>,
    /// Key (HTTPS) or smart card (PIN) label.
    pub label: Option<String>,
    /// The URL exactly as git printed it, user included (`https://alice@github.com`).
    pub url: Option<String>,
}

impl Prompt {
    fn new(kind: PromptKind, text: &str) -> Prompt {
        Prompt {
            kind,
            text: text.to_string(),
            host: None,
            user: None,
            key_path: None,
            label: None,
            url: None,
        }
    }
}

/// `'text'` at the start of `s` -> (text, rest). The text ends at the last quote of the line.
fn quoted(s: &str) -> Option<&str> {
    let s = s.trim().trim_end_matches(':').trim_end();
    let s = s.strip_prefix('\'')?;
    let end = s.rfind('\'')?;
    Some(&s[..end])
}

/// `s` without `prefix` (ASCII case-insensitive).
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// Splits `scheme://[user[:pw]@]host[:port][/path]` into `(origin, user)` where `origin` is
/// `scheme://host[:port]`.
fn split_url(url: &str) -> Option<(String, Option<String>)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let (userinfo, host) = match authority.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, authority),
    };
    if host.is_empty() {
        return None;
    }
    let user = userinfo
        .map(|u| u.split(':').next().unwrap_or(u))
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    Some((format!("{scheme}://{host}"), user))
}

/// Classifies one prompt. `hint` is `SSH_ASKPASS_PROMPT` (`confirm` marks a yes/no question).
pub fn parse(text: &str, hint: Option<&str>) -> Prompt {
    let trimmed = text.trim();
    let lower = trimmed.to_lowercase();

    if lower.contains("continue connecting") || hint == Some("confirm") {
        let mut p = Prompt::new(PromptKind::Hostkey, text);
        p.host = text
            .split_once("host '")
            .and_then(|(_, rest)| rest.split_once('\''))
            .map(|(h, _)| h.to_string());
        return p;
    }

    for (prefix, kind) in [
        ("username for ", PromptKind::Username),
        ("password for ", PromptKind::Password),
    ] {
        if let Some(rest) = strip_prefix_ci(trimmed, prefix) {
            if let Some(url) = quoted(rest) {
                if let Some((origin, user)) = split_url(url) {
                    let mut p = Prompt::new(kind, text);
                    p.host = Some(origin);
                    p.user = user;
                    p.url = Some(url.to_string());
                    return p;
                }
                // Not a URL: a credential for something else ("Password for 'cert.pem'").
                let mut p = Prompt::new(kind, text);
                p.label = Some(url.to_string());
                return p;
            }
        }
    }

    let passphrase_rest = strip_prefix_ci(trimmed, "enter passphrase for")
        .or_else(|| strip_prefix_ci(trimmed, "bad passphrase, try again for"));
    if let Some(rest) = passphrase_rest {
        let rest = rest.trim_start();
        let rest = rest.strip_prefix("key ").unwrap_or(rest).trim_start();
        let path = quoted(rest).map(str::to_string).or_else(|| {
            // Old format: `Enter passphrase for /path/key: ` (text after the last " (" is a hint).
            let r = rest.trim().trim_end_matches(':').trim_end();
            let r = r.split(" (will be").next().unwrap_or(r);
            (!r.is_empty()).then(|| r.to_string())
        });
        let mut p = Prompt::new(PromptKind::Passphrase, text);
        p.key_path = path;
        return p;
    }

    if let Some(rest) = strip_prefix_ci(trimmed, "enter pin for") {
        let mut p = Prompt::new(PromptKind::Pin, text);
        p.label = quoted(rest.trim_start()).map(str::to_string);
        return p;
    }

    // `alice@host's password:` and the PAM form `(alice@host) Password:`.
    let bare = trimmed.trim_end_matches(':').trim_end();
    if let Some(who) = bare.strip_suffix("'s password") {
        let mut p = Prompt::new(PromptKind::Password, text);
        p.user = who.split_once('@').map(|(u, _)| u.to_string());
        p.host = Some(who.to_string());
        return p;
    }
    if let Some(rest) = bare.strip_prefix('(') {
        if let Some((who, tail)) = rest.split_once(')') {
            if tail.trim().eq_ignore_ascii_case("password") && who.contains('@') {
                let mut p = Prompt::new(PromptKind::Password, text);
                p.user = who.split_once('@').map(|(u, _)| u.to_string());
                p.host = Some(who.to_string());
                return p;
            }
        }
    }

    Prompt::new(PromptKind::Unknown, text)
}

/// Key under which a credential for this prompt is saved (and looked up). `None` when the
/// prompt has no stable identity, so nothing can be saved.
///
/// - HTTPS password: `https://alice@github.com` (as git prints it)
/// - HTTPS user name: `login:https://github.com`
/// - ssh passphrase: the key path
/// - ssh password: `ssh://alice@host`
/// - smart card PIN: `pin:<label>`
pub fn store_key(p: &Prompt) -> Option<String> {
    match p.kind {
        PromptKind::Username => p.host.as_ref().map(|h| format!("login:{h}")),
        PromptKind::Password => match (&p.url, &p.host) {
            (Some(url), _) => Some(url.clone()),
            (None, Some(who)) if p.label.is_none() => Some(format!("ssh://{who}")),
            _ => None,
        },
        PromptKind::Passphrase => p.key_path.clone(),
        PromptKind::Pin => p.label.as_ref().map(|l| format!("pin:{l}")),
        PromptKind::Hostkey | PromptKind::Unknown => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_https_username_and_password() {
        let u = parse("Username for 'https://github.com': ", None);
        assert_eq!(u.kind, PromptKind::Username);
        assert_eq!(u.host.as_deref(), Some("https://github.com"));
        assert_eq!(u.user, None);
        assert_eq!(store_key(&u).as_deref(), Some("login:https://github.com"));

        let p = parse("Password for 'https://alice@github.com': ", None);
        assert_eq!(p.kind, PromptKind::Password);
        assert_eq!(p.host.as_deref(), Some("https://github.com"));
        assert_eq!(p.user.as_deref(), Some("alice"));
        assert_eq!(store_key(&p).as_deref(), Some("https://alice@github.com"));
    }

    #[test]
    fn git_urls_with_port_and_path_keep_the_origin() {
        let p = parse(
            "Username for 'https://git.example.com:8443/team/repo.git': ",
            None,
        );
        assert_eq!(p.host.as_deref(), Some("https://git.example.com:8443"));
        let p = parse(
            "Password for 'https://bob@git.example.com:8443/team/repo.git': ",
            None,
        );
        assert_eq!(p.user.as_deref(), Some("bob"));
        assert_eq!(
            store_key(&p).as_deref(),
            Some("https://bob@git.example.com:8443/team/repo.git")
        );
    }

    #[test]
    fn a_password_in_the_url_is_not_part_of_the_user() {
        let p = parse("Password for 'https://bob:secret@host.com': ", None);
        assert_eq!(p.user.as_deref(), Some("bob"));
    }

    #[test]
    fn a_git_prompt_for_something_else_is_a_labelled_password() {
        let p = parse("Password for 'cert.pem': ", None);
        assert_eq!(p.kind, PromptKind::Password);
        assert_eq!(p.label.as_deref(), Some("cert.pem"));
        assert_eq!(store_key(&p), None);
    }

    #[test]
    fn ssh_passphrase_formats() {
        for text in [
            "Enter passphrase for key '/home/a/.ssh/id_ed25519': ",
            "Enter passphrase for '/home/a/.ssh/id_ed25519': ",
            "Enter passphrase for /home/a/.ssh/id_ed25519: ",
        ] {
            let p = parse(text, None);
            assert_eq!(p.kind, PromptKind::Passphrase, "{text}");
            assert_eq!(
                p.key_path.as_deref(),
                Some("/home/a/.ssh/id_ed25519"),
                "{text}"
            );
            assert_eq!(store_key(&p).as_deref(), Some("/home/a/.ssh/id_ed25519"));
        }
    }

    #[test]
    fn ssh_add_asks_again_after_a_wrong_passphrase() {
        let p = parse("Bad passphrase, try again for /home/a/.ssh/id_rsa: ", None);
        assert_eq!(p.kind, PromptKind::Passphrase);
        assert_eq!(p.key_path.as_deref(), Some("/home/a/.ssh/id_rsa"));
    }

    #[test]
    fn ssh_password_and_pin() {
        let p = parse("alice@example.com's password: ", None);
        assert_eq!(p.kind, PromptKind::Password);
        assert_eq!(p.user.as_deref(), Some("alice"));
        assert_eq!(store_key(&p).as_deref(), Some("ssh://alice@example.com"));

        let p = parse("(alice@example.com) Password: ", None);
        assert_eq!(p.kind, PromptKind::Password);
        assert_eq!(store_key(&p).as_deref(), Some("ssh://alice@example.com"));

        let p = parse("Enter PIN for 'PIV_II': ", None);
        assert_eq!(p.kind, PromptKind::Pin);
        assert_eq!(store_key(&p).as_deref(), Some("pin:PIV_II"));
    }

    #[test]
    fn ssh_host_key_question() {
        let text = "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
        let p = parse(text, None);
        assert_eq!(p.kind, PromptKind::Hostkey);
        assert_eq!(p.host.as_deref(), Some("github.com (140.82.121.4)"));
        assert_eq!(store_key(&p), None);
        assert_eq!(
            parse("Add key to agent?", Some("confirm")).kind,
            PromptKind::Hostkey
        );
    }

    #[test]
    fn anything_else_is_unknown() {
        let p = parse("Verification code: ", None);
        assert_eq!(p.kind, PromptKind::Unknown);
        assert_eq!(store_key(&p), None);
        assert_eq!(parse("", None).kind, PromptKind::Unknown);
    }
}
