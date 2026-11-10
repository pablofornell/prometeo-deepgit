//! Lane layout of the commit graph (PLAN.md section 6).

use crate::model::{GraphRow, GraphSegment};

struct Lane<K> {
    expect: K,
    color: u16,
}

/// Stable colour for a branch name (FNV-1a), so a branch keeps its colour across reloads.
pub fn stable_color(name: &str) -> u16 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h % 1024) as u16
}

/// Lays out `rows` (display order; each is `(key, parent keys)`).
pub fn layout<K: Clone + Eq>(rows: &[(K, Vec<K>)]) -> Vec<GraphRow> {
    layout_with_hints(rows, &[])
}

/// Like `layout`; `hints[i]` is the colour a lane started by row `i` gets instead of the next
/// sequential colour. Missing entries mean no hint.
pub fn layout_with_hints<K: Clone + Eq>(
    rows: &[(K, Vec<K>)],
    hints: &[Option<u16>],
) -> Vec<GraphRow> {
    let mut lanes: Vec<Option<Lane<K>>> = Vec::new();
    let mut next_color: u16 = 0;
    let mut out = Vec::with_capacity(rows.len());

    for (i, (key, parents)) in rows.iter().enumerate() {
        let mut segments: Vec<GraphSegment> = Vec::new();

        // 1. Lanes expecting this commit; allocate one when none does.
        let mut matches: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, l)| l.as_ref().is_some_and(|l| l.expect == *key))
            .map(|(idx, _)| idx)
            .collect();
        let is_new = matches.is_empty();
        if is_new {
            let color = match hints.get(i).copied().flatten() {
                Some(c) => c,
                None => {
                    let c = next_color;
                    next_color = next_color.wrapping_add(1);
                    c
                }
            };
            let slot = first_free(&lanes, 0);
            set_lane(&mut lanes, slot, key.clone(), color);
            matches.push(slot);
        }
        let node = matches[0];
        let node_color = lanes[node].as_ref().map_or(0, |l| l.color);

        // 2. Top half: every matching lane converges on the node.
        if !is_new {
            for &m in &matches {
                let color = lanes[m].as_ref().map_or(node_color, |l| l.color);
                segments.push(seg(m, 0, node, 1, color));
            }
        }

        // 3. Pass-through lanes.
        for (idx, lane) in lanes.iter().enumerate() {
            if let Some(l) = lane {
                if !matches.contains(&idx) {
                    segments.push(seg(idx, 0, idx, 2, l.color));
                }
            }
        }

        // 4. Free the matching lanes.
        for &m in &matches {
            lanes[m] = None;
        }

        // 5. Parents.
        for (pi, parent) in parents.iter().enumerate() {
            let existing = lanes
                .iter()
                .position(|l| l.as_ref().is_some_and(|l| l.expect == *parent));
            if let Some(l) = existing {
                let color = lanes[l].as_ref().map_or(node_color, |l| l.color);
                segments.push(seg(node, 1, l, 2, color));
            } else if pi == 0 {
                set_lane(&mut lanes, node, parent.clone(), node_color);
                segments.push(seg(node, 1, node, 2, node_color));
            } else {
                let slot = first_free(&lanes, node + 1);
                let color = next_color;
                next_color = next_color.wrapping_add(1);
                set_lane(&mut lanes, slot, parent.clone(), color);
                segments.push(seg(node, 1, slot, 2, color));
            }
        }

        // 6. Trim and measure.
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        let max_x = segments
            .iter()
            .map(|s| s.x1.max(s.x2))
            .max()
            .unwrap_or(0)
            .max(node as u16);
        out.push(GraphRow {
            node: node as u16,
            color: node_color,
            segments,
            width: max_x + 1,
        });
    }
    out
}

fn seg(x1: usize, y1: u8, x2: usize, y2: u8, color: u16) -> GraphSegment {
    GraphSegment {
        x1: x1 as u16,
        y1,
        x2: x2 as u16,
        y2,
        color,
    }
}

/// First empty slot at or after `from`, or the index a push would get.
fn first_free<K>(lanes: &[Option<Lane<K>>], from: usize) -> usize {
    (from..lanes.len())
        .find(|&i| lanes[i].is_none())
        .unwrap_or_else(|| lanes.len().max(from))
}

fn set_lane<K>(lanes: &mut Vec<Option<Lane<K>>>, slot: usize, expect: K, color: u16) {
    while lanes.len() <= slot {
        lanes.push(None);
    }
    lanes[slot] = Some(Lane { expect, color });
}
