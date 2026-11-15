mod common;
#[path = "common/phase_c.rs"]
mod parity;
use aditor::{cv::Image, valorant::*};
use serde_json::{json, Value};
fn row(id: &Value) -> FeedRow {
    let r = &parity::cases()["rows"][id.as_str().unwrap()];
    FeedRow {
        slot: r["slot"].as_u64().unwrap() as usize,
        kind: r["type"].as_str().unwrap().into(),
        signature: serde_json::from_value(r["signature"].clone()).unwrap(),
        confirmed: r["confirmed"].as_bool().unwrap(),
        identity: serde_json::from_value(r["identity"].clone()).unwrap(),
    }
}
fn profile() -> ValorantProfile {
    load_valorant_profile(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../templates/valorant/icons"),
    )
    .unwrap()
}
#[test]
fn python_feed_detection_and_tracking_cases() {
    let det = FeedDetector::new(&profile());
    for c in parity::cases()["detections"].as_array().unwrap() {
        let rows = det
            .observations(&parity::image(c["frame"].as_str().unwrap()))
            .unwrap();
        let expected: Vec<_> = c["rows"].as_array().unwrap().iter().map(row).collect();
        assert_eq!(rows.len(), expected.len(), "{c}");
        for (a, b) in rows.iter().zip(expected) {
            assert_eq!(
                (a.slot, &a.kind, a.confirmed),
                (b.slot, &b.kind, b.confirmed),
                "{c}"
            );
            parity::close(&json!(a.signature), &json!(b.signature));
            parity::close(&json!(a.identity), &json!(b.identity));
        }
    }
    for trace in parity::cases()["feed_traces"].as_array().unwrap() {
        let mut tr = FeedTracker::default();
        for c in trace.as_array().unwrap() {
            let rows: Vec<_> = c["rows"].as_array().unwrap().iter().map(row).collect();
            parity::close(&json!(tr.feed(c["t"].as_f64().unwrap(), &rows)), &c["new"]);
            parity::close(&json!(tr.events), &c["events"]);
        }
    }
}
#[test]
fn restore_validates_profile_and_covers_every_aspect() {
    let p = profile();
    assert_eq!(p.capture_banner, capture_rect(BANNER_REF, true));
    assert_eq!(p.capture_spec, capture_rect(SPEC_REF, false));
    let b = Image::new(
        p.capture_banner[2] as usize,
        256,
        3,
        vec![60; p.capture_banner[2] as usize * 256 * 3],
    )
    .unwrap();
    let s = Image::new(
        p.capture_spec[2] as usize,
        64,
        3,
        vec![60; p.capture_spec[2] as usize * 64 * 3],
    )
    .unwrap();
    for (_, a) in aditor::layout::SUPPORTED_ASPECTS {
        let p = p.with_layout(aditor::layout::Layout::from_ratio(a));
        let (b, s) = p.restore(&b, &s).unwrap();
        assert_eq!((b.width, b.height, s.width, s.height), (600, 256, 460, 64));
    }
    let temp = common::TempDir::new();
    std::fs::write(
        temp.0.join("profile.json"),
        r#"{"templates_version":"v","capture_rois":{"banner":[1,2,3,4],"spec":[1,2,3,4]}}"#,
    )
    .unwrap();
    assert!(load_valorant_profile(&temp.0).is_err());
}
#[test]
fn reanalysis_preserves_edits_then_rebuilds_highlights() {
    for c in parity::cases()["merges"].as_array().unwrap() {
        let (events, lost) = merge_events(
            &serde_json::from_value::<Vec<_>>(c["base"].clone()).unwrap(),
            &serde_json::from_value::<Vec<_>>(c["detected"].clone()).unwrap(),
            &serde_json::from_value::<Vec<_>>(c["rounds"].clone()).unwrap(),
        );
        parity::close(&json!(events), &c["events"]);
        parity::close(&json!(lost), &c["lost"]);
    }
}

#[test]
fn stretched_and_letterboxed_restore_pixels_match_python() {
    for c in parity::cases()["restores"].as_array().unwrap() {
        let p = profile().with_layout(aditor::layout::Layout {
            squash: c["squash"].as_f64().unwrap(),
        });
        let (b, s) = p
            .restore(
                &parity::image(c["banner"].as_str().unwrap()),
                &parity::image(c["spec"].as_str().unwrap()),
            )
            .unwrap();
        assert_eq!(b, parity::image(c["expected_banner"].as_str().unwrap()));
        assert_eq!(s, parity::image(c["expected_spec"].as_str().unwrap()));
    }
}

/// Kill-feed crop (600x256, 1080p reference coordinates) from a fixture; a shorter strip is placed at row `y` and padded.
fn feed_fixture(rel: &str) -> Image<u8> {
    feed_fixture_at(rel, 0)
}

fn feed_fixture_at(rel: &str, y: usize) -> Image<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(rel);
    let strip = aditor::cv::read_png(&path, false).unwrap();
    assert_eq!((strip.width, strip.channels), (600, 3), "{rel}");
    let mut data = vec![0; 600 * 256 * 3];
    data[y * 600 * 3..y * 600 * 3 + strip.data.len()].copy_from_slice(&strip.data);
    Image::new(600, 256, 3, data).unwrap()
}

fn confirmed(rel: &str) -> Vec<(usize, String)> {
    FeedDetector::new(&profile())
        .observations(&feed_fixture(rel))
        .unwrap()
        .into_iter()
        .filter(|r| r.confirmed)
        .map(|r| (r.slot, r.kind))
        .collect()
}

#[test]
fn own_rows_on_compressed_footage_are_confirmed() {
    // 720p upload, 47.75 s: "Jett -> Me" death whose blurred chevron is only 10x15 px.
    assert_eq!(
        confirmed("valorant_feed/own_death_short_chevron.png"),
        [(0, "death".into())]
    );
    // 720p upload, 75.75 s: "Me -> Clove" kill below an enemy-kills-ally row; only the player's row counts.
    assert_eq!(
        confirmed("valorant_feed/own_kill_lone_chevron.png"),
        [(1, "kill".into())]
    );
}

#[test]
fn rows_that_are_not_the_players_are_rejected() {
    for rel in [
        // 720p upload rows without the player's yellow marking.
        "valorant_feed/teammate_kill.png",
        "valorant_feed/enemy_kills_ally.png",
        "valorant_feed/clove_resurrect.png",
        // Teammate kills with a yellow-bordered assist portrait left of the row.
        "valorant_feed/teammate_kill_assist_badge.png",
        "valorant_feed/teammate_kill_assist_badge_2.png",
        // Empty, fading and faded-out feeds.
        "valorant_feed/empty_feed.png",
        "valorant_feed/fade_to_dark.png",
        "valorant_feed/partially_faded_row.png",
        // 1080p: yellow clothing behind a teammate's row (see fixtures/valorant/README.md).
        "valorant/yellow-clothing-background.png",
    ] {
        assert_eq!(confirmed(rel), [], "{rel}");
    }
}

#[test]
fn native_1080p_player_rows_stay_detected() {
    // See fixtures/valorant/README.md for the source of each strip.
    let kill = |slot: usize| (slot, String::from("kill"));
    assert_eq!(confirmed("valorant/outlined-player-background.png"), [kill(1)]);
    assert_eq!(confirmed("valorant/faint-player-chevron.png"), [kill(1)]);
    assert_eq!(confirmed("valorant/sparse-player-chevrons.png"), [kill(1), kill(2)]);
    // This strip sits at y=80..139 of the feed crop.
    let rows = FeedDetector::new(&profile())
        .observations(&feed_fixture_at("valorant/compact-player-row.png", 80))
        .unwrap();
    let rows: Vec<_> = rows.into_iter().filter(|r| r.confirmed).map(|r| (r.slot, r.kind)).collect();
    assert_eq!(rows, [kill(2)]);
}
