// Injury as a *probability*, not a verdict. Two deliberately gentle signals derived only from a
// player's CURRENT Sleeper status — never a standing "injury-prone" tax on a healthy player:
//
//   * weekAvailability(status): probability the player actually suits up THIS week. Used to fade a
//     single week's projection in the sim / start-sit (a player ruled Out contributes ~0 that week).
//     This one can be sharp, because it's a one-week fact, not a season judgement.
//
//   * seasonAvailabilityMult(status): rest-of-season value nudge. Kept VERY small on purpose. A
//     "Questionable" tag is transient and mostly noise over a full season, so it doesn't move value
//     at all. Only statuses that imply real missed time (IR/PUP/Out) dock anything, and even then
//     gently — the cost of under-rating an elite player who returns healthy is far worse than the
//     cost of slightly over-rating a banged-up one. We would rather accept injury risk than misprice
//     a star for it.
//
// Status strings are Sleeper's `injury_status` / `status`. Unknown or healthy ⇒ neutral.

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase()

// Statuses that mean "not playing right now" for a single week.
function weekProb(status: string | null | undefined): number {
  switch (norm(status)) {
    case "out":
    case "ir":
    case "pup":
    case "sus": // suspended
    case "na": // inactive / not active
    case "dnr": // did not report
    case "cov": // covid list
      return 0
    case "doubtful":
      return 0.25
    case "questionable":
      return 0.9 // minimal — most Q players play
    default:
      return 1 // healthy, ACT, null, or anything unrecognized
  }
}

// Probability a player is available for a given week, given both the roster `status` (IR/PUP live
// here) and the game-day `injury_status` (Q/D/Out live here). Takes the more pessimistic of the two.
export function weekAvailability(status: string | null | undefined, injuryStatus: string | null | undefined): number {
  return Math.min(weekProb(status), weekProb(injuryStatus))
}

// Rest-of-season value multiplier — intentionally tiny. Questionable/Doubtful don't move season
// value (transient); only genuine multi-week absences dock, and gently.
export function seasonAvailabilityMult(status: string | null | undefined, injuryStatus: string | null | undefined): number {
  const worst = (s: string | null | undefined): number => {
    switch (norm(s)) {
      case "ir":
        return 0.85 // real multi-week absence — the only status with a meaningful ROS dock
      case "pup":
        return 0.9
      case "na":
      case "dnr":
      case "sus":
        return 0.9
      case "out":
        return 0.97 // week-to-week "out" is nearly all short-term over a season
      case "doubtful":
      case "questionable":
        return 1 // transient — no season-value penalty
      default:
        return 1
    }
  }
  return Math.min(worst(status), worst(injuryStatus))
}

// Convenience: is the player unavailable enough this week that they shouldn't be optimized into a
// lineup at all (Out/IR/etc.)? Used where a hard yes/no is cleaner than a probability.
export function isOutThisWeek(status: string | null | undefined, injuryStatus: string | null | undefined): boolean {
  return weekAvailability(status, injuryStatus) <= 0
}
