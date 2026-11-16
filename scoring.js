// =====================================================================
// scoring.js — Υπολογισμός πόντων γύρου (καθαρή συνάρτηση, εύκολη στο test).
// =====================================================================
const { SCORING } = require('./config');

/** Η τελική εγκυρότητα λαμβάνει υπόψη την αμφισβήτηση (αντιστροφή). */
function isEffectivelyValid(ans) {
  if (!ans || !ans.validation) return false;
  if (ans.validation.status === 'empty') return false;
  return ans.flipped ? !ans.validation.valid : ans.validation.valid;
}

/**
 * @param {string[]} playerIds
 * @param {string[]} categoryIds
 * @param {object} answers  answers[playerId][categoryId] = { word, submittedAt, validation, flipped }
 * @param {number} startedAt  server time έναρξης γύρου (ms)
 * @param {number} durationMs  συνολικός χρόνος γύρου (ms)
 * @returns {{ perPlayer: Object<string, {total:number, cats:Object}> }}
 */
function scoreRound(playerIds, categoryIds, answers, startedAt, durationMs) {
  const perPlayer = {};
  for (const pid of playerIds) perPlayer[pid] = { total: 0, cats: {} };

  for (const cat of categoryIds) {
    // Μαζεύουμε τις έγκυρες απαντήσεις της κατηγορίας
    const valid = [];
    for (const pid of playerIds) {
      const ans = answers[pid] && answers[pid][cat];
      if (isEffectivelyValid(ans)) valid.push({ pid, ans });
    }

    // Πόσοι έγραψαν την ίδια (κανονικοποιημένη) λέξη
    const keyCount = {};
    for (const { ans } of valid) {
      const k = ans.validation.key;
      keyCount[k] = (keyCount[k] || 0) + 1;
    }

    // Ποιος υπέβαλε πρώτος έγκυρη λέξη (ισοπαλία στο ms → όλοι παίρνουν bonus)
    const firstTime = valid.length ? Math.min(...valid.map((v) => v.ans.submittedAt)) : null;

    for (const pid of playerIds) {
      const ans = answers[pid] && answers[pid][cat];
      const entry = { base: 0, speed: 0, first: 0, points: 0, valid: false };
      if (isEffectivelyValid(ans)) {
        entry.valid = true;
        entry.base = keyCount[ans.validation.key] > 1 ? SCORING.SHARED_BASE : SCORING.UNIQUE_BASE;
        const remaining = Math.max(0, durationMs - (ans.submittedAt - startedAt));
        entry.speed = Math.round(SCORING.SPEED_BONUS_MAX * Math.min(1, remaining / durationMs));
        entry.first = ans.submittedAt === firstTime ? SCORING.FIRST_BONUS : 0;
        entry.points = entry.base + entry.speed + entry.first;
      } else {
        entry.points = SCORING.INVALID;
      }
      perPlayer[pid].cats[cat] = entry;
      perPlayer[pid].total += entry.points;
    }
  }
  return { perPlayer };
}

module.exports = { scoreRound, isEffectivelyValid };
