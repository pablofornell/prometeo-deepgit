use gitcore::graph::{layout, stable_color};
use gitcore::GraphSegment;

fn row(k: &'static str, parents: &[&'static str]) -> (&'static str, Vec<&'static str>) {
    (k, parents.to_vec())
}

fn seg(x1: u16, y1: u8, x2: u16, y2: u8, color: u16) -> GraphSegment {
    GraphSegment {
        x1,
        y1,
        x2,
        y2,
        color,
    }
}

#[test]
fn linear_history_uses_one_lane() {
    let g = layout(&[row("c", &["b"]), row("b", &["a"]), row("a", &[])]);
    assert!(g
        .iter()
        .all(|r| r.node == 0 && r.width == 1 && r.color == 0));
    assert_eq!(g[0].segments, vec![seg(0, 1, 0, 2, 0)]);
    assert_eq!(g[1].segments, vec![seg(0, 0, 0, 1, 0), seg(0, 1, 0, 2, 0)]);
    // Root commit: only the top half.
    assert_eq!(g[2].segments, vec![seg(0, 0, 0, 1, 0)]);
}

#[test]
fn branch_and_merge_use_two_lanes() {
    // m merges main(b) and feature(c); both come from a.
    let g = layout(&[
        row("m", &["b", "c"]),
        row("b", &["a"]),
        row("c", &["a"]),
        row("a", &[]),
    ]);
    // m: lane 0 continues to b, new lane 1 (colour 1) for c.
    assert_eq!(g[0].node, 0);
    assert_eq!(g[0].segments, vec![seg(0, 1, 0, 2, 0), seg(0, 1, 1, 2, 1)]);
    assert_eq!(g[0].width, 2);
    // b: lane 1 passes through, lane 0 goes on to a.
    assert_eq!(g[1].node, 0);
    assert!(g[1].segments.contains(&seg(1, 0, 1, 2, 1)));
    assert!(g[1].segments.contains(&seg(0, 1, 0, 2, 0)));
    // c sits on lane 1, its parent a is already expected by lane 0: segment bends to lane 0.
    assert_eq!(g[2].node, 1);
    assert_eq!(g[2].color, 1);
    assert!(g[2].segments.contains(&seg(1, 1, 0, 2, 0)));
    // a joins both lanes.
    assert_eq!(g[3].node, 0);
    assert_eq!(g[3].width, 1);
    assert_eq!(g.iter().map(|r| r.width).max(), Some(2));
}

#[test]
fn octopus_merge_opens_one_lane_per_extra_parent() {
    let g = layout(&[
        row("o", &["a", "b", "c"]),
        row("a", &[]),
        row("b", &[]),
        row("c", &[]),
    ]);
    assert_eq!(
        g[0].segments,
        vec![seg(0, 1, 0, 2, 0), seg(0, 1, 1, 2, 1), seg(0, 1, 2, 2, 2)]
    );
    assert_eq!(g[0].width, 3);
    assert_eq!(g[1].node, 0);
    assert_eq!(g[2].node, 1);
    assert_eq!(g[3].node, 2);
    // Lanes are freed as their commits are consumed.
    assert_eq!(g[3].width, 3);
}

#[test]
fn two_independent_roots_get_separate_colors_and_reuse_lanes() {
    let g = layout(&[row("x2", &["x1"]), row("y1", &[]), row("x1", &[])]);
    // y1 starts a new lane right of x's lane.
    assert_eq!(g[1].node, 1);
    assert_eq!(g[1].color, 1);
    assert!(g[1].segments.contains(&seg(0, 0, 0, 2, 0)));
    // After y1 (a root) its lane is freed; x1 is still on lane 0.
    assert_eq!(g[2].node, 0);
    assert_eq!(g[2].width, 1);
}

#[test]
fn a_row_nobody_expects_reuses_the_first_free_slot() {
    // Two unrelated tips, then each one's parent; slot of the finished lane is reused.
    let g = layout(&[row("a", &[]), row("b", &["c"]), row("c", &[])]);
    assert_eq!(g[0].node, 0);
    assert_eq!(g[1].node, 0);
    assert_eq!(g[1].width, 1);
    assert_eq!(g[2].node, 0);
}

#[test]
fn stable_color_is_deterministic_and_bounded() {
    assert_eq!(stable_color("main"), stable_color("main"));
    assert_ne!(stable_color("main"), stable_color("develop"));
    assert!(stable_color("feature/some-long-name") < 1024);
}
