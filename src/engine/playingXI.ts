import {
  Player,
  PlayingXIConfig,
  PlayingXIPreset,
  PlayingXISlot,
  SeasonRuleset,
  TeamState,
} from './types';

function presetScore(player: Player, preset: PlayingXIPreset): number {
  const r = player.ratings;
  switch (preset) {
    case 'BATTING_HEAVY':
      return r.overall * 0.55 + r.batting * 0.4 + r.form * 0.05;
    case 'BOWLING_HEAVY':
      return r.overall * 0.55 + r.bowling * 0.4 + r.form * 0.05;
    case 'SPIN_FOCUSED':
      return (
        r.overall * 0.7 +
        (player.primaryRole === 'Spinner' || player.secondaryRole === 'Spin All-rounder' ? 22 : 0)
      );
    case 'PACE_FOCUSED':
      return (
        r.overall * 0.7 +
        (player.primaryRole === 'Fast Bowler' || player.secondaryRole === 'Pace All-rounder' ? 22 : 0)
      );
    case 'BALANCED':
    default:
      return r.overall * 0.75 + r.form * 0.15 + r.fielding * 0.1;
  }
}

function getBattingOrderWeight(p: Player): number {
  if (p.secondaryRole === 'Top-order Batter' || p.specialtyTags.includes('Powerplay Opener')) return 1;
  if (p.primaryRole === 'Wicketkeeper' && p.ratings.batting >= 84) return 2;
  if (p.secondaryRole === 'Middle-order Batter') return 3;
  if (p.secondaryRole === 'Finisher') return 4;
  if (p.primaryRole === 'All-rounder') return 5;
  if (p.primaryRole === 'Spinner') return 6;
  return 7;
}

function describeSelection(p: Player, roleLabel: string): string {
  if (p.primaryRole === 'Wicketkeeper') {
    return `Selected as frontline gloveman and ${p.secondaryRole.toLowerCase()} (SR ${p.stats.strikeRate.toFixed(1)}).`;
  }
  if (p.secondaryRole === 'Death-over Specialist') {
    return `Anchors overs 16–20 with ${p.stats.wickets} IPL wickets and ${p.stats.economy.toFixed(2)} economy.`;
  }
  if (p.primaryRole === 'Spinner') {
    return `Controls middle overs (7–15) with ${p.stats.economy.toFixed(2)} economy (${p.stats.wickets} wkts).`;
  }
  if (p.primaryRole === 'All-rounder') {
    return `Provides vital dual-skill balance (Bat ${p.ratings.batting} / Bowl ${p.ratings.bowling}).`;
  }
  if (p.secondaryRole === 'Finisher') {
    return `Closes the innings in the death overs with a ${p.stats.strikeRate.toFixed(1)} strike rate.`;
  }
  if (p.primaryRole === 'Fast Bowler') {
    return `Leads pace attack (${p.secondaryRole}) with ${p.stats.wickets} career wickets.`;
  }
  return `Locks in ${roleLabel.toLowerCase()} stability (${p.stats.runs} IPL runs, Avg ${p.stats.battingAvg.toFixed(1)}).`;
}

export function generateBestPlayingXI(
  team: TeamState,
  ruleset: SeasonRuleset,
  playerMap: Record<string, Player>,
  preset: PlayingXIPreset = 'BALANCED',
  customStarterIds?: string[]
): PlayingXIConfig {
  const priceMap = new Map<string, number>();
  const squadPlayers: Player[] = [];
  for (const sp of team.squad) {
    const p = playerMap[sp.playerId];
    if (p) {
      squadPlayers.push(p);
      priceMap.set(p.id, sp.boughtPriceCr);
    }
  }

  let selected: Player[] = [];

  if (customStarterIds && customStarterIds.length > 0) {
    selected = customStarterIds
      .map((id) => playerMap[id])
      .filter((p): p is Player => Boolean(p) && squadPlayers.some((sp) => sp.id === p.id))
      .slice(0, 11);
  } else {
    const remaining = [...squadPlayers].sort((a, b) => presetScore(b, preset) - presetScore(a, preset));
    let osUsed = 0;

    const tryPick = (predicate: (p: Player) => boolean, count: number) => {
      let picked = 0;
      for (let i = 0; i < remaining.length && picked < count; ) {
        const candidate = remaining[i];
        if (predicate(candidate)) {
          if (candidate.isOverseas && osUsed >= ruleset.maxOverseasPlayingXI) {
            i++;
            continue;
          }
          selected.push(candidate);
          if (candidate.isOverseas) osUsed++;
          remaining.splice(i, 1);
          picked++;
        } else {
          i++;
        }
      }
    };

    // 1. At least 1 Wicketkeeper
    tryPick((p) => p.primaryRole === 'Wicketkeeper', 1);
    // 2. Role targets based on tactical preset
    if (preset === 'BATTING_HEAVY') {
      tryPick((p) => p.primaryRole === 'Batter', 4);
      tryPick((p) => p.primaryRole === 'All-rounder', 2);
      tryPick((p) => p.primaryRole === 'Fast Bowler', 2);
      tryPick((p) => p.primaryRole === 'Spinner', 2);
    } else if (preset === 'BOWLING_HEAVY') {
      tryPick((p) => p.primaryRole === 'Fast Bowler', 3);
      tryPick((p) => p.primaryRole === 'Spinner', 2);
      tryPick((p) => p.primaryRole === 'All-rounder', 2);
      tryPick((p) => p.primaryRole === 'Batter', 3);
    } else if (preset === 'SPIN_FOCUSED') {
      tryPick((p) => p.primaryRole === 'Spinner', 3);
      tryPick((p) => p.secondaryRole === 'Spin All-rounder', 1);
      tryPick((p) => p.primaryRole === 'Fast Bowler', 2);
      tryPick((p) => p.primaryRole === 'Batter', 3);
    } else if (preset === 'PACE_FOCUSED') {
      tryPick((p) => p.primaryRole === 'Fast Bowler', 4);
      tryPick((p) => p.secondaryRole === 'Pace All-rounder', 1);
      tryPick((p) => p.primaryRole === 'Spinner', 1);
      tryPick((p) => p.primaryRole === 'Batter', 3);
    } else {
      // BALANCED
      tryPick((p) => p.secondaryRole === 'Top-order Batter', 2);
      tryPick((p) => p.primaryRole === 'Fast Bowler', 3);
      tryPick((p) => p.primaryRole === 'Spinner', 2);
      tryPick((p) => p.primaryRole === 'All-rounder', 2);
      tryPick((p) => p.primaryRole === 'Batter', 1);
    }

    // Fill any remaining slots up to 11 respecting overseas limit
    tryPick(() => true, 11 - selected.length);
  }

  // Sort starters into realistic batting order (1..11)
  selected.sort((a, b) => {
    const wa = getBattingOrderWeight(a);
    const wb = getBattingOrderWeight(b);
    if (wa !== wb) return wa - wb;
    return b.ratings.batting - a.ratings.batting;
  });

  // Determine Captain, Vice-Captain, Wicketkeeper
  const captainCandidates = [...selected].sort((a, b) => b.ratings.captaincy - a.ratings.captaincy);
  const captainId = captainCandidates[0]?.id;
  const viceCaptainId = captainCandidates[1]?.id;
  const keeper =
    selected.find((p) => p.primaryRole === 'Wicketkeeper') ??
    selected.find((p) => p.specialtyTags.includes('Backup Keeper'));

  const starters: PlayingXISlot[] = selected.map((p, idx) => {
    const order = idx + 1;
    let roleLabel = p.secondaryRole as string;
    if (order <= 2) roleLabel = 'Opener';
    else if (order === 3 || order === 4) roleLabel = 'Top / Middle Order';
    else if (order === 5 || order === 6) roleLabel = p.secondaryRole === 'Finisher' ? 'Finisher' : 'Middle Order';
    else if (order === 7) roleLabel = p.primaryRole === 'All-rounder' ? 'All-rounder' : 'Lower-Middle';

    return {
      order,
      player: p,
      priceCr: priceMap.get(p.id) ?? p.basePriceCr,
      roleLabel,
      selectionReason: describeSelection(p, roleLabel),
      isCaptain: p.id === captainId,
      isViceCaptain: p.id === viceCaptainId,
      isWicketkeeper: p.id === keeper?.id,
    };
  });

  const starterIdSet = new Set(selected.map((p) => p.id));
  const bench = squadPlayers
    .filter((p) => !starterIdSet.has(p.id))
    .sort((a, b) => b.ratings.overall - a.ratings.overall);

  const overseasCount = selected.filter((p) => p.isOverseas).length;

  // Impact Player: prefer Indian bench player if 4 overseas already in XI
  const impactCandidate =
    bench.find((p) => !p.isOverseas || overseasCount < ruleset.maxOverseasPlayingXI) ?? bench[0] ?? null;

  const impactPlayer = impactCandidate
    ? {
        player: impactCandidate,
        reason:
          impactCandidate.primaryRole === 'Fast Bowler' || impactCandidate.primaryRole === 'Spinner'
            ? `Tactical second-innings bowling substitute (${impactCandidate.secondaryRole}).`
            : `High-impact batting sub (SR ${impactCandidate.stats.strikeRate.toFixed(1)}) for chase acceleration.`,
      }
    : null;

  const validationErrors: string[] = [];
  if (selected.length < 11) {
    validationErrors.push(`Only ${selected.length}/11 starters available in squad.`);
  }
  if (overseasCount > ruleset.maxOverseasPlayingXI) {
    validationErrors.push(
      `Overseas limit exceeded in XI (${overseasCount}/${ruleset.maxOverseasPlayingXI}).`
    );
  }
  if (!keeper) {
    validationErrors.push('No wicketkeeper selected in the Playing XI.');
  }

  const bowlingOptionsCount = selected.filter(
    (p) =>
      p.primaryRole === 'Fast Bowler' ||
      p.primaryRole === 'Spinner' ||
      p.primaryRole === 'All-rounder'
  ).length;
  if (bowlingOptionsCount < 5) {
    validationErrors.push(`Only ${bowlingOptionsCount} bowling options (recommended 5+).`);
  }

  const xiRating =
    selected.length > 0
      ? Math.round(selected.reduce((s, p) => s + p.ratings.overall, 0) / selected.length)
      : 0;

  return {
    preset,
    starters,
    impactPlayer,
    bench,
    overseasCount,
    isValid: validationErrors.length === 0,
    validationErrors,
    bowlingOptionsCount,
    xiRating,
  };
}
