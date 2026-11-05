import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, any>;

type SummaryItem = {
  name: string;
  total_seconds?: number;
  percent?: number;
  ai_additions?: number;
  ai_deletions?: number;
  ai_sessions?: number;
  ai_input_tokens?: number;
  ai_output_tokens?: number;
  ai_model_breakdown?: Array<{ name: string; lines?: number; input_tokens?: number; output_tokens?: number; cost?: number }>;
};

type DaySummary = {
  grand_total?: {
    total_seconds?: number;
    ai_additions?: number;
    ai_deletions?: number;
    ai_sessions?: number;
    ai_input_tokens?: number;
    ai_output_tokens?: number;
    ai_model_breakdown?: Array<{ name: string; lines?: number; input_tokens?: number; output_tokens?: number; cost?: number }>;
  };
  editors?: SummaryItem[];
  languages?: SummaryItem[];
  projects?: SummaryItem[];
  range?: { date?: string; timezone?: string };
};

type Duration = {
  time: number;
  duration: number;
  editor?: string;
  project?: string;
  language?: string;
  ai_additions?: number;
  ai_deletions?: number;
  ai_sessions?: number;
  ai_input_tokens?: number;
  ai_output_tokens?: number;
};

const API_BASE = "https://api.wakatime.com/api/v1";
const TOKEN = process.env.WAKATIME_ACCESS_TOKEN;
const TIMEZONE = process.env.WAKATIME_TIMEZONE || "UTC";
const README_PATH = resolve(process.env.README_PATH || "README.md");
const SVG_PATH = resolve(process.env.HEATMAP_PATH || "assets/coding-activity.svg");
const REPO = process.env.GITHUB_REPOSITORY || "";
const BRANCH = process.env.GITHUB_REF_NAME || "main";

if (!TOKEN) {
  throw new Error("Missing WAKATIME_ACCESS_TOKEN environment variable.");
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function wakaGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1));
        continue;
      }

      const body = await response.json() as JsonObject;
      if (!response.ok) {
        const detail = body?.error || body?.errors?.[0]?.message || JSON.stringify(body);
        throw new Error(`WakaTime API ${response.status} for ${path}: ${detail}`);
      }
      return body as T;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`WakaTime request failed: ${path}`);
}

function formatHour(seconds: number, timezone: string): number {
  const date = new Date(seconds * 1000);
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return Number(hour);
}

function splitDurationIntoHours(duration: Duration, hours: number[], timezone: string): void {
  let cursor = duration.time;
  let remaining = duration.duration;
  // Allocate in one-minute slices. This keeps timezone/DST handling correct without
  // assuming that every local day has exactly 24 elapsed hours.
  while (remaining > 0) {
    const slice = Math.min(60, remaining);
    const hour = formatHour(cursor, timezone);
    if (hour >= 0 && hour < 24) hours[hour] += slice;
    cursor += slice;
    remaining -= slice;
  }
}

function bar(seconds: number, max: number): string {
  const levels = " ▁▂▃▄▅▆▇█";
  if (seconds <= 0 || max <= 0) return "·";
  const index = Math.max(1, Math.min(8, Math.ceil((seconds / max) * 8)));
  return levels[index];
}

function renderHourlyTimeline(days: Array<{ date: string; hours: number[]; total: number }>): string {
  const maxHour = Math.max(1, ...days.flatMap((day) => day.hours));
  const lines = [
    "<!-- Hourly activity: each block represents one local hour; intensity is relative to the busiest hour in this view. -->",
    "| Day | 24-hour activity (00 → 24) | Total |",
    "|:---|:---|---:|",
  ];

  for (const day of days) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(`${day.date}T12:00:00Z`));
    const blocks = day.hours.map((seconds) => bar(seconds, maxHour)).join("");
    lines.push(`| **${weekday} ${day.date.slice(5)}** | \`${blocks}\` | ${formatDuration(day.total)} |`);
  }

  lines.push("", "`00`　　 `06`　　 `12`　　 `18`　　 `24`", "");
  return lines.join("\n");
}

function renderHeatmap(days: DaySummary[], endDate: string, timezone: string): string {
  const startDate = shiftDate(endDate, -364);
  const values = new Map<string, number>();
  for (const day of days) {
    const date = day.range?.date;
    if (date) values.set(date, number(day.grand_total?.total_seconds));
  }

  const start = new Date(`${startDate}T00:00:00Z`);
  const startWeekday = start.getUTCDay();
  const gridStart = shiftDate(startDate, -startWeekday);
  const cells: Array<{ date: string; seconds: number }> = [];
  for (let i = 0; i < 371; i++) {
    const date = shiftDate(gridStart, i);
    cells.push({ date, seconds: values.get(date) || 0 });
  }

  const max = Math.max(1, ...cells.map((cell) => cell.seconds));
  const colors = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];
  const cellSize = 11;
  const gap = 3;
  const left = 34;
  const top = 24;
  const width = left + 53 * (cellSize + gap);
  const height = top + 7 * (cellSize + gap) + 10;
  const rects: string[] = [];
  const monthLabels: string[] = [];

  for (let week = 0; week < 53; week++) {
    const firstDate = cells[week * 7]?.date;
    if (firstDate && firstDate.slice(8) <= "07") {
      const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
        .format(new Date(`${firstDate}T12:00:00Z`));
      monthLabels.push(`<text x="${left + week * (cellSize + gap)}" y="12" fill="#8b949e" font-size="10">${month}</text>`);
    }

    for (let weekday = 0; weekday < 7; weekday++) {
      const cell = cells[week * 7 + weekday];
      if (!cell) continue;
      const ratio = cell.seconds / max;
      const level = cell.seconds === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(ratio * 4)));
      const x = left + week * (cellSize + gap);
      const y = top + weekday * (cellSize + gap);
      const title = `${cell.date}: ${formatDuration(cell.seconds)}`;
      rects.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${colors[level]}"><title>${escapeHtml(title)}</title></rect>`);
    }
  }

  const weekdayLabels = ["Mon", "Wed", "Fri"].map((label, index) => {
    const y = top + (index * 2 + 1) * (cellSize + gap) - 2;
    return `<text x="0" y="${y}" fill="#8b949e" font-size="9">${label}</text>`;
  }).join("");

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Coding activity heatmap for the last 365 days">`,
    `<rect width="100%" height="100%" rx="6" fill="#0d1117"/>`,
    ...monthLabels,
    weekdayLabels,
    ...rects,
    `<text x="${left}" y="${height - 1}" fill="#8b949e" font-size="9">Less</text>`,
    ...colors.map((color, index) => `<rect x="${left + 30 + index * 15}" y="${height - 10}" width="10" height="10" rx="2" fill="${color}"/>`),
    `<text x="${left + 112}" y="${height - 1}" fill="#8b949e" font-size="9">More</text>`,
    `</svg>`,
  ].join("\n");

  return svg;
}

function sumItems(items: SummaryItem[], matcher: (name: string) => boolean): SummaryItem {
  const matches = items.filter((item) => matcher(item.name));
  return matches.reduce<SummaryItem>((total, item) => ({
    name: "Claude Code",
    total_seconds: number(total.total_seconds) + number(item.total_seconds),
    ai_additions: number(total.ai_additions) + number(item.ai_additions),
    ai_deletions: number(total.ai_deletions) + number(item.ai_deletions),
    ai_sessions: number(total.ai_sessions) + number(item.ai_sessions),
    ai_input_tokens: number(total.ai_input_tokens) + number(item.ai_input_tokens),
    ai_output_tokens: number(total.ai_output_tokens) + number(item.ai_output_tokens),
  }), { name: "Claude Code" });
}

function renderCompactStats(week: DaySummary[]): string {
  const totalSeconds = week.reduce((sum, day) => sum + number(day.grand_total?.total_seconds), 0);
  const activeDays = week.filter((day) => number(day.grand_total?.total_seconds) > 0).length;
  const average = activeDays ? totalSeconds / activeDays : 0;
  const best = [...week].sort((a, b) => number(b.grand_total?.total_seconds) - number(a.grand_total?.total_seconds))[0];

  const languageTotals = new Map<string, number>();
  const projectTotals = new Map<string, number>();
  const editorTotals = new Map<string, number>();

  for (const day of week) {
    for (const item of day.languages || []) languageTotals.set(item.name, (languageTotals.get(item.name) || 0) + number(item.total_seconds));
    for (const item of day.projects || []) projectTotals.set(item.name, (projectTotals.get(item.name) || 0) + number(item.total_seconds));
    for (const item of day.editors || []) editorTotals.set(item.name, (editorTotals.get(item.name) || 0) + number(item.total_seconds));
  }

  const top = (map: Map<string, number>) => [...map.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, seconds]) => `${name} (${formatDuration(seconds)})`).join(" · ") || "No data";

  const bestDate = best?.range?.date || "—";
  const claude = sumItems(week.flatMap((day) => day.editors || []), (name) => /claude\s*code/i.test(name));

  return [
    "| Metric | This week |",
    "|:--|--:|",
    `| Total coding time | **${formatDuration(totalSeconds)}** |`,
    `| Daily average (active days) | ${formatDuration(average)} |`,
    `| Active days | ${activeDays}/7 |`,
    `| Most productive day | ${bestDate} · ${formatDuration(number(best?.grand_total?.total_seconds))} |`,
    `| Top languages | ${top(languageTotals)} |`,
    `| Top projects | ${top(projectTotals)} |`,
    "",
    "**Editor breakdown**",
    "",
    ...[...editorTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([name, seconds]) => `- ${/claude\s*code/i.test(name) ? "**Claude Code**" : name}: ${formatDuration(seconds)}`),
    "",
    "**Claude Code · weekly usage**",
    "",
    `- Tracked editor time: **${formatDuration(number(claude.total_seconds))}**`,
    `- AI sessions: ${claude.ai_sessions ? claude.ai_sessions.toLocaleString("en-US") : "Not reported by this integration"}`,
    `- AI additions: ${claude.ai_additions ? claude.ai_additions.toLocaleString("en-US") : "Not reported by this integration"}`,
    `- AI deletions: ${claude.ai_deletions ? claude.ai_deletions.toLocaleString("en-US") : "Not reported by this integration"}`,
    `- AI tokens (input / output): ${claude.ai_input_tokens || claude.ai_output_tokens ? `${number(claude.ai_input_tokens).toLocaleString("en-US")} / ${number(claude.ai_output_tokens).toLocaleString("en-US")}` : "Not reported by this integration"}`,
    "",
    "_Claude Code appears in the editor breakdown and in its dedicated summary above. AI line/token fields are shown only when WakaTime returns them for that editor._",
  ].join("\n");
}

function replaceSection(readme: string, content: string): string {
  const start = "<!--START_SECTION:CODING_ACTIVITY-->";
  const end = "<!--END_SECTION:CODING_ACTIVITY-->";
  const startIndex = readme.indexOf(start);
  const endIndex = readme.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`README.md must contain ${start} and ${end} markers.`);
  }

  return `${readme.slice(0, startIndex + start.length)}\n\n${content}\n\n${readme.slice(endIndex)}`;
}

async function main(): Promise<void> {
  const now = new Date();
  const today = dateInTimezone(now, TIMEZONE);
  const yearStart = shiftDate(today, -364);
  const weekStart = shiftDate(today, -6);

  console.log(`Fetching WakaTime data for ${yearStart} through ${today} (${TIMEZONE})`);

  const summariesResponse = await wakaGet<{ data: DaySummary[]; cumulative_total?: { seconds?: number } }>(
    "/users/current/summaries",
    { start: yearStart, end: today, timezone: TIMEZONE },
  );

  const summaries = summariesResponse.data || [];
  const summaryByDate = new Map(summaries.map((day) => [day.range?.date || "", day]));
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(weekStart, index);
    return summaryByDate.get(date) || { range: { date }, grand_total: { total_seconds: 0 }, editors: [], languages: [], projects: [] };
  });

  const hourlyDays: Array<{ date: string; hours: number[]; total: number }> = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = shiftDate(today, -offset);
    const response = await wakaGet<{ data: Duration[]; timezone?: string }>(
      "/users/current/durations",
      { date, timezone: TIMEZONE, slice_by: "editor" },
    );
    const hours = Array.from({ length: 24 }, () => 0);
    for (const duration of response.data || []) {
      if (typeof duration.time === "number" && typeof duration.duration === "number") {
        splitDurationIntoHours(duration, hours, response.timezone || TIMEZONE);
      }
    }
    const summary = summaryByDate.get(date);
    hourlyDays.push({
      date,
      hours,
      total: number(summary?.grand_total?.total_seconds) || hours.reduce((sum, value) => sum + value, 0),
    });
  }

  const hourlyMarkdown = renderHourlyTimeline(hourlyDays);
  const weeklyMarkdown = renderCompactStats(week);
  const heatmap = renderHeatmap(summaries, today, TIMEZONE);

  await mkdir(dirname(SVG_PATH), { recursive: true });
  await writeFile(SVG_PATH, heatmap, "utf8");

  const generatedAt = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: TIMEZONE,
  }).format(now);

  const imagePath = REPO
    ? `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(BRANCH)}/assets/coding-activity.svg`
    : "./assets/coding-activity.svg";

  const content = [
    "## ⏱️ Daily coding timeline",
    "",
    `> Hourly activity · Last 7 days · ${escapeHtml(TIMEZONE)}`,
    "",
    hourlyMarkdown,
    "## 🗓️ Coding activity · Last 365 days",
    "",
    `![Coding activity heatmap](${imagePath})`,
    "",
    "## 📊 Weekly coding summary",
    "",
    weeklyMarkdown,
    "",
    `<sub>Last updated: ${escapeHtml(generatedAt)} · Source: WakaTime</sub>`,
  ].join("\n");

  const readme = await readFile(README_PATH, "utf8");
  await writeFile(README_PATH, replaceSection(readme, content), "utf8");

  console.log(`Updated ${README_PATH}`);
  console.log(`Updated ${SVG_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
