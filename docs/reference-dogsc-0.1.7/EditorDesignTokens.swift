import AppKit
import SwiftUI

// MARK: - Design Tokens (Soft Silver / Graphite)

public enum EditorTheme {
    // The media remains colour-accurate while workspace chrome follows the
    // selected Aqua appearance. Dynamic NSColor providers also update panels
    // already on screen when the user changes appearance in Settings.
    public static let backgroundDeep = adaptive(
        light: NSColor(calibratedRed: 0.925, green: 0.929, blue: 0.937, alpha: 1),
        dark: NSColor(calibratedRed: 0.028, green: 0.029, blue: 0.033, alpha: 1)
    )
    public static let panelSurface = adaptive(
        light: NSColor(calibratedRed: 0.992, green: 0.992, blue: 0.996, alpha: 1),
        dark: NSColor(calibratedRed: 0.063, green: 0.065, blue: 0.072, alpha: 1)
    )
    public static let sleepingMonitor = adaptive(
        light: NSColor(calibratedWhite: 0.79, alpha: 1),
        dark: NSColor(calibratedWhite: 0.24, alpha: 1)
    )
    public static let panelRaised = adaptive(
        light: NSColor(calibratedRed: 0.955, green: 0.957, blue: 0.963, alpha: 1),
        dark: NSColor(calibratedRed: 0.098, green: 0.1, blue: 0.11, alpha: 1)
    )
    /// The island: every floating tool surface shares the recorder's base.
    public static let cardElevated = adaptive(
        light: NSColor(calibratedRed: 0.992, green: 0.992, blue: 0.996, alpha: 1),
        dark: NSColor(calibratedRed: 0.063, green: 0.065, blue: 0.072, alpha: 1)
    )
    /// Islands are lit from above: a touch brighter at the top edge and a
    /// touch deeper toward the workspace, so a flat slab reads as material.
    static let cardTop = adaptive(
        light: NSColor(calibratedRed: 0.992, green: 0.992, blue: 0.996, alpha: 1),
        dark: NSColor(calibratedRed: 0.063, green: 0.065, blue: 0.072, alpha: 1)
    )
    static let cardBottom = adaptive(
        light: NSColor(calibratedRed: 0.992, green: 0.992, blue: 0.996, alpha: 1),
        dark: NSColor(calibratedRed: 0.063, green: 0.065, blue: 0.072, alpha: 1)
    )
    /// Docked chrome (title bar, track header column) sits a half step
    /// below the panels it frames.
    static let chromeBar = adaptive(
        light: NSColor(calibratedRed: 0.992, green: 0.992, blue: 0.996, alpha: 1),
        dark: NSColor(calibratedRed: 0.063, green: 0.065, blue: 0.072, alpha: 1)
    )
    /// The stage the canvas stands on.
    static let stage = adaptive(
        light: NSColor(calibratedRed: 0.925, green: 0.929, blue: 0.937, alpha: 1),
        dark: NSColor(calibratedRed: 0.028, green: 0.029, blue: 0.033, alpha: 1)
    )
    static var cardGradient: LinearGradient {
        LinearGradient(colors: [cardTop, cardBottom], startPoint: .top, endPoint: .bottom)
    }
    /// The soft pool of light the monitor stands in.
    static let stageLight = adaptive(
        light: NSColor(calibratedWhite: 1.0, alpha: 0.72),
        dark: NSColor(calibratedRed: 0.55, green: 0.58, blue: 0.68, alpha: 0.075)
    )
    static let stageVignette = adaptive(
        light: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.18, alpha: 0.06),
        dark: NSColor.black.withAlphaComponent(0.42)
    )
    /// A soft halo for the current choice and the solid primary action.
    static let accentGlow = adaptive(
        light: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.18, alpha: 0.22),
        dark: NSColor(calibratedWhite: 1.0, alpha: 0.16)
    )
    /// Gentle top-to-bottom shading for the solid platinum fill.
    static let platinumAccentDeep = adaptive(
        light: NSColor(calibratedWhite: 0.12, alpha: 1),
        dark: NSColor(calibratedWhite: 0.97, alpha: 1)
    )
    static var platinumGradient: LinearGradient {
        LinearGradient(colors: [platinumAccent, platinumAccentDeep], startPoint: .top, endPoint: .bottom)
    }
    public static let timelineClipTop = adaptive(
        light: NSColor(calibratedWhite: 0.88, alpha: 1),
        dark: NSColor(calibratedWhite: 0.22, alpha: 1)
    )
    public static let timelineClipBottom = adaptive(
        light: NSColor(calibratedWhite: 0.83, alpha: 1),
        dark: NSColor(calibratedWhite: 0.17, alpha: 1)
    )
    // The zoom lane uses the 运镜 task colour: a light wash, the hue for
    // rings and handles, and the deep shade (or the hue in dark) for text.
    public static let timelineZoomSurface = EditorConsole.Track.zoom.soft
    /// The zoom identity at full strength: selection rings and handles.
    static let timelineZoomAccent = EditorConsole.Track.zoom.stroke
    static let timelineZoomInk = EditorConsole.Track.zoom.softInk
    public static let recorderSurface = panelSurface
    public static let mediaAccent = Color(red: 0.949, green: 0.941, blue: 0.918)

    public static let platinumAccent = adaptive(
        light: NSColor(calibratedWhite: 0.12, alpha: 1),
        dark: NSColor(calibratedWhite: 0.97, alpha: 1)
    )
    public static let platinumMuted = adaptive(
        light: NSColor(calibratedWhite: 0.40, alpha: 1),
        dark: NSColor(calibratedWhite: 0.56, alpha: 1)
    )
    /// Foreground paired with solid accent fills in both workspace themes.
    public static let onAccent = adaptive(
        light: NSColor(calibratedWhite: 1.0, alpha: 1),
        dark: NSColor(calibratedWhite: 0.08, alpha: 1)
    )
    public static let controlWell = adaptive(
        light: NSColor(calibratedWhite: 0.0, alpha: 0.05),
        dark: NSColor(calibratedWhite: 1.0, alpha: 0.06)
    )
    public static let amberAccent = Color(red: 0.95, green: 0.68, blue: 0.28)
    /// Warm botanical green aligned with the editor's lime family.
    public static let success = Color(red: 0.52, green: 0.82, blue: 0.26)
    public static let recording = Color(red: 1.0, green: 0.27, blue: 0.23)

    public static let selectionTint = platinumAccent
    /// Current choice in a navigation group: the recorder's neutral 14% lift.
    public static let railSelectionWash = adaptive(
        light: NSColor(calibratedWhite: 0.0, alpha: 0.075),
        dark: NSColor(calibratedWhite: 1.0, alpha: 0.14)
    )
    public static let selectionWash = adaptive(
        light: NSColor(calibratedWhite: 0.0, alpha: 0.075),
        dark: NSColor(calibratedWhite: 1.0, alpha: 0.14)
    )
    public static let hairline = chrome(0.06)
    static let controlBorder = chrome(0.085)
    static let groupSurface = chrome(0.035)
    /// The one fill for grouped content inside an island: cards, disclosure
    /// groups, info notes and stages' wells. Flat, no outline.
    static let cardFill = chrome(0.045)
    // Native popovers own their brighter backdrop, including the arrow. Keep
    // selection relative to that surface and small helper copy fully legible.
    static let popoverSelectionSurface = selectionWash.opacity(0.6)
    static let popoverSecondaryText = adaptive(
        light: NSColor(calibratedWhite: 0.32, alpha: 1),
        dark: NSColor(calibratedWhite: 0.86, alpha: 1)
    )
    /// The machined top edge of an island, fading toward the bottom.
    public static let topHighlight = adaptive(
        light: NSColor(calibratedWhite: 1.0, alpha: 1.0),
        dark: NSColor(calibratedWhite: 1.0, alpha: 0.17)
    )
    /// Slider parts: a quiet rail, a near-black (or near-white) filled run
    /// and a paper thumb that stays light in both appearances.
    static let sliderRail = chrome(0.075)
    static let sliderInk = adaptive(
        light: NSColor(calibratedWhite: 0.12, alpha: 1),
        dark: NSColor(calibratedWhite: 0.92, alpha: 1)
    )
    static let sliderThumb = adaptive(
        light: .white,
        dark: NSColor(calibratedWhite: 0.97, alpha: 1)
    )
    /// The silhouette hairline every island draws on its outer edge.
    static let islandOutline = adaptive(
        light: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.18, alpha: 0.075),
        dark: NSColor(calibratedWhite: 1.0, alpha: 0.07)
    )
    /// A tight shadow where an island meets the workspace, under the soft one.
    static let contactShadow = adaptive(
        light: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.18, alpha: 0.06),
        dark: NSColor.black.withAlphaComponent(0.5)
    )
    public static let softShadow = adaptive(
        light: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.18, alpha: 0.11),
        dark: NSColor.black.withAlphaComponent(0.42)
    )
    /// The wide, faint falloff under a floating island.
    static let ambientShadow = adaptive(
        light: NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.18, alpha: 0.07),
        dark: NSColor.black.withAlphaComponent(0.30)
    )

    /// Text roles stay readable on the neutral control and panel surfaces.
    /// Opacity remains useful for decoration, but not for small helper copy.
    static let primaryText = adaptive(
        light: NSColor(calibratedWhite: 0.1, alpha: 1),
        dark: NSColor(calibratedWhite: 0.96, alpha: 1)
    )
    static let secondaryText = adaptive(
        light: NSColor(calibratedWhite: 0.36, alpha: 1),
        dark: NSColor(calibratedWhite: 0.66, alpha: 1)
    )
    /// Section captions: one step below helper copy, still AA on the island.
    static let tertiaryText = adaptive(
        light: NSColor(calibratedWhite: 0.52, alpha: 1),
        dark: NSColor(calibratedWhite: 0.46, alpha: 1)
    )

    /// Foreground/border ink for chrome. Media-overlay controls intentionally
    /// keep their explicit white/black colours and do not use this token.
    public static func chrome(_ opacity: Double = 1) -> Color {
        adaptive(light: .black, dark: .white).opacity(opacity)
    }

    private static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? dark
                : light
        })
    }
}

/// A close type scale keeps a tool dense without giving every label the
/// weight of a heading. PuHui remains the single interface font family.
/// One set of state washes for every flat control: hover lifts the same
/// amount everywhere, press a little more, an open menu trigger in between.
enum EditorStateWash {
    static let hover: Double = 0.07
    static let open: Double = 0.1
    static let pressed: Double = 0.12
}

/// Editor text uses five sizes: 10 micro (badges, axes), 11 caption,
/// 12 label, 13 body, and headings from 14 up. Values use monospaced digits.
enum EditorTypography {
    static var panelTitle: Font { .appUI(size: 15, weight: .semibold) }
    static var sectionTitle: Font { .appUI(size: 12, weight: .semibold) }
    static var controlLabel: Font { .appUI(size: 12) }
    static var controlValue: Font { .appUI(size: 12, weight: .medium) }
    static var helper: Font { .appUI(size: 12) }
    static var caption: Font { .appUI(size: 11, weight: .medium) }
    /// Small section captions: tracked, quiet, never competing with values.
    static var eyebrow: Font { .appUI(size: 11, weight: .semibold) }
}

enum EditorInterfaceSpacing {
    static let inspectorInset: CGFloat = 14
    static let sectionGap: CGFloat = 16
    static let controlGap: CGFloat = 8
    static let headingGap: CGFloat = 6
    /// Content inset inside a settings-style tile.
    static let tileInset: CGFloat = 14
}

/// Radii describe nesting roles rather than individual screens. Small controls
/// sit inside groups; only detached workspace surfaces carry the largest curve.
enum EditorInterfaceRadius {
    static let compact: CGFloat = 8
    static let control: CGFloat = 10
    static let group: CGFloat = 12
    static let card: CGFloat = 14
    static let floating: CGFloat = 20
    /// Settings-style tiles holding a group of controls.
    static let tile: CGFloat = 18
}

enum EditorInterfaceHeight {
    static let compact: CGFloat = 30
    static let selection: CGFloat = 32
    static let action: CGFloat = 32
}

// MARK: - Product Motion

public enum SpringMotion {
    private static var reducesMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// Controls settle quickly with almost no overshoot; a visible bounce on
    /// every hover and press reads as a toy. Larger panels take a slower,
    /// fully settled spring. Reduce Motion still removes spatial transitions.
    public static var interactive: Animation? {
        reducesMotion ? nil : .spring(response: 0.3, dampingFraction: 1)
    }

    public static var fluid: Animation? {
        reducesMotion ? nil : .spring(response: 0.45, dampingFraction: 1)
    }

    /// Text changes fade briefly without scaling glyphs or moving their baseline.
    public static var crossfade: Animation? {
        reducesMotion ? nil : .easeOut(duration: 0.16)
    }

    public static var snappy: Animation? {
        reducesMotion ? nil : .spring(response: 0.24, dampingFraction: 1)
    }

    public static var gentle: Animation? {
        reducesMotion ? nil : .spring(response: 0.55, dampingFraction: 1)
    }

    /// Selection thumbs, indicators and expanding groups: one smooth glide
    /// with no overshoot, the same everywhere in the editor.
    public static var settle: Animation? {
        reducesMotion ? nil : .spring(response: 0.38, dampingFraction: 1)
    }

    /// Hover arrives softly and leaves a little faster than it came.
    public static var hover: Animation {
        reducesMotion ? .linear(duration: 0.01) : .easeOut(duration: 0.15)
    }

    /// A lively but fully settled spring for small lifts and thumbs.
    public static var lift: Animation? {
        reducesMotion ? nil : .spring(response: 0.28, dampingFraction: 1)
    }
}

// MARK: - Shared finishes

/// The raised slab used for every current choice: segmented thumbs, tool
/// rail selection, tiles and toggles in a toolbar. Paper on Aqua, a lit
/// graphite slab on Dark Aqua, with a top bevel and a two-step shadow.
struct EditorRaisedThumb<S: InsettableShape>: View {
    let shape: S
    var fill: Color = EditorChoiceStyle.thumb
    var elevated = true
    var usesAccent = true
    @Environment(\.consolePalette) private var palette

    var body: some View {
        if let palette, usesAccent {
            // Inside the inspector the current choice carries its task's
            // colour: one flat fill, no outline, no glow.
            shape
                .fill(palette.fill)
                .shadow(color: EditorChoiceStyle.thumbShadow.opacity(elevated ? 1 : 0), radius: 2, y: 1)
                .allowsHitTesting(false)
        } else {
            shape
                .fill(fill)
                .overlay { shape.strokeBorder(EditorTheme.chrome(0.05), lineWidth: 0.5) }
                // Settings' adaptive thumb shadow: present on paper, still
                // readable on graphite, never a halo.
                .shadow(color: EditorChoiceStyle.thumbShadow.opacity(elevated ? 1 : 0), radius: 2, y: 1)
                .allowsHitTesting(false)
        }
    }
}

/// A short fading rule: strong in the middle, gone at both ends.
struct EditorFadingHairline: View {
    var axis: Axis = .horizontal
    var opacity: Double = 0.08

    var body: some View {
        let gradient = LinearGradient(
            stops: [
                .init(color: EditorTheme.chrome(0), location: 0),
                .init(color: EditorTheme.chrome(opacity), location: 0.18),
                .init(color: EditorTheme.chrome(opacity), location: 0.82),
                .init(color: EditorTheme.chrome(0), location: 1)
            ],
            startPoint: axis == .horizontal ? .leading : .top,
            endPoint: axis == .horizontal ? .trailing : .bottom
        )
        Rectangle()
            .fill(gradient)
            .frame(width: axis == .vertical ? 1 : nil, height: axis == .horizontal ? 1 : nil)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
