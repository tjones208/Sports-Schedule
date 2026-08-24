// GET /api/leagues - what the board can load, without fetching any schedules.
import { LEAGUES, LEAGUE_IDS } from '../lib/leagues.mjs';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=86400');
  res.status(200).json({
    leagues: LEAGUE_IDS.map((id) => ({
      league: id,
      name: LEAGUES[id].name,
      longName: LEAGUES[id].longName,
      season: LEAGUES[id].season,
      range: { start: LEAGUES[id].start, end: LEAGUES[id].end },
    })),
  });
}
