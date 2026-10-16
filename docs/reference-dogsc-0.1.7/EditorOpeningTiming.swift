import Foundation

/// The gesture uses the rail's fixed coordinate space and its initial scale,
/// even when changing duration rescales the schedule drawn underneath it.
struct EditorOpeningTimingDrag {
    enum Adjustment: Equatable {
        case duration
        case stagger(index: Int)
    }

    let adjustment: Adjustment
    private let secondsPerPoint: Double
    private var previousTranslation = 0.0

    init(adjustment: Adjustment, domain: Double, width: Double) {
        self.adjustment = adjustment
        secondsPerPoint = domain / max(width, 1)
    }

    mutating func delta(translation: Double) -> Double? {
        guard translation.isFinite else { return nil }
        let delta = (translation - previousTranslation) * secondsPerPoint
        previousTranslation = translation
        switch adjustment {
        case .duration: return delta
        case let .stagger(index): return delta / Double(max(index, 1))
        }
    }
}

struct EditorOpeningTimingGeometry {
    let domain: Double
    let width: Double
    let stagger: Double
    let elementDuration: Double

    init(duration: Double, stagger: Double, count: Int, minimumDuration: Double,
         domain: Double, width: Double) {
        self.domain = max(domain, duration, 1)
        self.width = max(width, 0)
        self.stagger = min(max(stagger, 0), max(duration - minimumDuration, 0) / Double(max(count - 1, 1)))
        elementDuration = max(duration - self.stagger * Double(max(count - 1, 0)), minimumDuration)
    }

    func interval(index: Int) -> ClosedRange<Double> {
        let start = stagger * Double(index)
        return start...(start + elementDuration)
    }

    func frame(index: Int) -> (x: Double, width: Double) {
        let interval = interval(index: index)
        let start = min(max(interval.lowerBound / domain * width, 0), width)
        let end = min(max(interval.upperBound / domain * width, start), width)
        return (start, end - start)
    }
}
