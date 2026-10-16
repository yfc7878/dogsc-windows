import AppKit
import SwiftUI

/// Input stays in one unscaled native rectangle while the SwiftUI artwork
/// grows on hover/press. Wheel events are consumed only over this control;
/// they never also scroll the inspector or create an undo step per pixel.
struct EditorKnobPointerInput: NSViewRepresentable {
    let isEnabled: Bool
    let onHover: (Bool) -> Void
    let onDragBegin: (CGPoint, CGPoint) -> Bool
    let onDragChange: (CGPoint, Bool) -> Void
    let onDragEnd: () -> Void
    let onWheelBegin: () -> Bool
    let onWheelChange: (Double) -> Void
    let onWheelEnd: () -> Void

    func makeNSView(context: Context) -> InputView { InputView() }

    func updateNSView(_ view: InputView, context: Context) {
        view.input = self
        if !isEnabled { view.finish() }
    }

    static func dismantleNSView(_ view: InputView, coordinator: ()) {
        view.finish()
        view.input = nil
    }

    final class InputView: NSView {
        var input: EditorKnobPointerInput?
        private var rotating = false
        private var scrolling = false
        private var wheelCompletion: DispatchWorkItem?
        private var wheelGeneration = 0
        private var tracking: NSTrackingArea?

        override var isFlipped: Bool { true }
        override var mouseDownCanMoveWindow: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func hitTest(_ point: NSPoint) -> NSView? {
            guard input?.isEnabled == true else { return nil }
            return super.hitTest(point)
        }

        override func resetCursorRects() {
            if input?.isEnabled == true { addCursorRect(bounds, cursor: .openHand) }
        }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let tracking { removeTrackingArea(tracking) }
            let area = NSTrackingArea(rect: bounds,
                options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                owner: self, userInfo: nil)
            addTrackingArea(area)
            tracking = area
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: nil)
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(windowResignedKey),
                    name: NSWindow.didResignKeyNotification, object: window)
            } else { finish() }
        }

        @objc private func windowResignedKey(_ notification: Notification) { finish() }
        override func mouseEntered(with event: NSEvent) { input?.onHover(true) }
        override func mouseExited(with event: NSEvent) {
            input?.onHover(false)
            finishWheel()
        }

        override func mouseDown(with event: NSEvent) {
            finishWheel()
            guard input?.isEnabled == true else { return }
            let point = convert(event.locationInWindow, from: nil)
            rotating = input?.onDragBegin(point, CGPoint(x: bounds.midX, y: bounds.midY)) == true
            if rotating { NSCursor.closedHand.set() }
        }

        override func mouseDragged(with event: NSEvent) {
            guard rotating else { return }
            input?.onDragChange(convert(event.locationInWindow, from: nil), event.modifierFlags.contains(.shift))
        }

        override func mouseUp(with event: NSEvent) {
            guard rotating else { return }
            input?.onDragChange(convert(event.locationInWindow, from: nil), event.modifierFlags.contains(.shift))
            rotating = false
            input?.onDragEnd()
            window?.invalidateCursorRects(for: self)
        }

        override func scrollWheel(with event: NSEvent) {
            guard input?.isEnabled == true, window?.isKeyWindow == true,
                  !rotating, !event.modifierFlags.contains(.command) else {
                super.scrollWheel(with: event)
                return
            }
            // Inertial motion must not continue changing a parameter after
            // fingers leave the trackpad or move over another knob.
            if !event.momentumPhase.isEmpty { finishWheel(); return }
            if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
                finishWheel()
                return
            }
            guard let delta = EditorKnobDragState.wheelDelta(
                vertical: Double(event.scrollingDeltaY), horizontal: Double(event.scrollingDeltaX),
                precise: event.hasPreciseScrollingDeltas,
                inverted: event.isDirectionInvertedFromDevice,
                fine: event.modifierFlags.contains(.shift)
            ) else { super.scrollWheel(with: event); return }
            if !scrolling {
                guard input?.onWheelBegin() == true else { return }
                scrolling = true
            }
            input?.onWheelChange(delta)
            wheelCompletion?.cancel()
            wheelGeneration += 1
            let generation = wheelGeneration
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.wheelGeneration == generation else { return }
                    self.finishWheel()
                }
            }
            wheelCompletion = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22, execute: work)
        }

        private func finishWheel() {
            wheelGeneration += 1
            wheelCompletion?.cancel()
            wheelCompletion = nil
            guard scrolling else { return }
            scrolling = false
            input?.onWheelEnd()
        }

        func finish() {
            finishWheel()
            if rotating {
                rotating = false
                input?.onDragEnd()
            }
            input?.onHover(false)
            window?.invalidateCursorRects(for: self)
        }
    }
}
