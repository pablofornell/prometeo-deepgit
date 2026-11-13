//! Mouse side buttons (back and forward) on Linux.
//!
//! WebKitGTK may not pass the X11 buttons 8 and 9 to the page as DOM buttons 3 and 4, and it can use them for its own page
//! history. So the buttons are read from the GTK widget of the webview: a press of 8 emits `nav-back`, a press of 9 emits
//! `nav-forward`, and the event stops there (WebKit never sees it). The frontend (`state/navigation.ts`) listens to both
//! events and to the DOM buttons, and navigates once when both arrive for one press. On other systems nothing is installed.

/// The Tauri event for a GDK mouse button, or `None` for any other button.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn event_for_button(button: u32) -> Option<&'static str> {
    match button {
        8 => Some("nav-back"),
        9 => Some("nav-forward"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
pub fn install(app: &tauri::AppHandle) {
    use gtk::glib::Propagation;
    use gtk::prelude::*;
    use tauri::{Emitter, Manager};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let result = window.with_webview(move |webview| {
        let view = webview.inner();
        view.connect_button_press_event(move |_, event| {
            let Some(name) = event_for_button(event.button()) else {
                return Propagation::Proceed;
            };
            // A double or triple click also arrives as a press: stop it, but navigate once.
            if event.event_type() == gtk::gdk::EventType::ButtonPress {
                let _ = handle.emit(name, ());
            }
            Propagation::Stop
        });
        view.connect_button_release_event(|_, event| {
            if event_for_button(event.button()).is_some() {
                Propagation::Stop
            } else {
                Propagation::Proceed
            }
        });
    });
    if let Err(e) = result {
        tracing::warn!("mouse side buttons: {e}");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::event_for_button;

    #[test]
    fn side_buttons_map_to_navigation_events() {
        assert_eq!(event_for_button(8), Some("nav-back"));
        assert_eq!(event_for_button(9), Some("nav-forward"));
    }

    #[test]
    fn other_buttons_are_left_alone() {
        for b in [0, 1, 2, 3, 4, 5, 6, 7, 10] {
            assert_eq!(event_for_button(b), None);
        }
    }
}
