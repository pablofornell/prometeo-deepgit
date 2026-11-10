//! The colour palette of repositories and projects: how many colours there are, how a new item gets
//! one, and how a user choice is validated. The colour values themselves live in the frontend
//! (`src/theme/colors.css`); here there are only palette indexes and `#RRGGBB` strings.

/// Number of palette colours. Equals `PALETTE_SIZE` in `src/theme/palette.ts`.
pub const PALETTE_SIZE: u8 = 12;

/// Stored in `Project.color` by files written before projects had colours. Never shown: the
/// workspace replaces it with a real index when it loads.
pub const UNASSIGNED: u8 = u8::MAX;

/// What the user asked for when changing a colour.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ColorChoice {
    /// Go back to the automatic colour.
    Auto,
    /// A palette colour (always `< PALETTE_SIZE`).
    Palette(u8),
    /// A custom colour, normalized to upper-case `#RRGGBB`.
    Custom(String),
}

impl ColorChoice {
    /// Checks the arguments of the `repo_set_color` / `project_set_color` commands. Give a palette
    /// index, or a custom colour, or neither (Auto).
    pub fn parse(color: Option<u8>, custom: Option<&str>) -> Result<Self, String> {
        match (color, custom) {
            (Some(_), Some(_)) => {
                Err("Give a palette color or a custom color, not both".to_string())
            }
            (Some(i), None) if i < PALETTE_SIZE => Ok(Self::Palette(i)),
            (Some(_), None) => Err("Unknown palette color".to_string()),
            (None, Some(hex)) => normalize_hex(hex)
                .map(Self::Custom)
                .ok_or_else(|| "Invalid color, expected #RRGGBB".to_string()),
            (None, None) => Ok(Self::Auto),
        }
    }
}

/// `#RRGGBB` in any letter case becomes upper case; anything else is `None`.
pub fn normalize_hex(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let ok = b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit);
    ok.then(|| s.to_ascii_uppercase())
}

/// The palette index used least among `used` (indexes `>= PALETTE_SIZE` are ignored). On a tie the
/// lowest index wins, so a fresh workspace hands out 0, 1, 2, ... and the result is stable.
pub fn next_color(used: impl IntoIterator<Item = u8>) -> u8 {
    let mut counts = [0usize; PALETTE_SIZE as usize];
    for c in used {
        if let Some(n) = counts.get_mut(c as usize) {
            *n += 1;
        }
    }
    let min = counts.iter().copied().min().unwrap_or(0);
    counts.iter().position(|&n| n == min).unwrap_or(0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_colors_go_in_index_order() {
        let mut used = Vec::new();
        for want in 0..PALETTE_SIZE {
            let c = next_color(used.iter().copied());
            assert_eq!(c, want);
            used.push(c);
        }
        // all 12 used once: the cycle starts again
        assert_eq!(next_color(used.iter().copied()), 0);
    }

    #[test]
    fn least_used_wins_and_ties_take_the_lowest_index() {
        // 0 and 1 used twice, 2 once, the rest never: lowest unused is 3
        assert_eq!(next_color([0, 0, 1, 1, 2]), 3);
        // every colour used, but 7 only once less than the others
        let mut used: Vec<u8> = (0..PALETTE_SIZE).flat_map(|c| [c, c]).collect();
        used.retain(|&c| c != 7);
        used.push(7);
        assert_eq!(next_color(used), 7);
        // junk indexes are ignored
        assert_eq!(next_color([UNASSIGNED, 200]), 0);
    }

    #[test]
    fn choice_validation() {
        assert_eq!(ColorChoice::parse(None, None), Ok(ColorChoice::Auto));
        assert_eq!(
            ColorChoice::parse(Some(0), None),
            Ok(ColorChoice::Palette(0))
        );
        assert_eq!(
            ColorChoice::parse(Some(11), None),
            Ok(ColorChoice::Palette(11))
        );
        assert_eq!(
            ColorChoice::parse(Some(12), None),
            Err("Unknown palette color".to_string())
        );
        assert_eq!(
            ColorChoice::parse(None, Some("#1a2B3c")),
            Ok(ColorChoice::Custom("#1A2B3C".to_string()))
        );
        for bad in [
            "", "red", "#12345", "#1234567", "1A2B3C", "#GGGGGG", "#12 456",
        ] {
            assert_eq!(
                ColorChoice::parse(None, Some(bad)),
                Err("Invalid color, expected #RRGGBB".to_string()),
                "{bad}"
            );
        }
        assert!(ColorChoice::parse(Some(1), Some("#FFFFFF")).is_err());
    }
}
