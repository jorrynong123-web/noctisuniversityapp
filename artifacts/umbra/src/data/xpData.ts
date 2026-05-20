// Auto-extracted from UmbraApp.tsx
export const PROFILE_TAGS = [
  { label: "Dark Academic",       color: "#7c5c2e" },
  { label: "Old Money Energy",    color: "#4a6741" },
  { label: "Bookworm",            color: "#5c3d7a" },
  { label: "Social Butterfly",    color: "#7a3d5c" },
  { label: "Lone Wolf",           color: "#2e4a5c" },
  { label: "Creative Soul",       color: "#7a5c3d" },
  { label: "The Analyst",         color: "#3d5c7a" },
  { label: "Poet at Heart",       color: "#6b3d7a" },
  { label: "Night Owl",           color: "#2a2a4a" },
  { label: "The Romantic",        color: "#7a3d4a" },
  { label: "Cynical Mind",        color: "#3d4a3d" },
  { label: "Ambition First",      color: "#7a6b3d" },
  { label: "Aesthetic Obsessed",  color: "#5c3d6b" },
  { label: "The Philosopher",     color: "#3d5c5c" },
  { label: "Main Character",      color: "#7a4a3d" },
  { label: "Chaos Agent",         color: "#5c2e2e" },
  { label: "Quiet Intensity",     color: "#2e3d5c" },
  { label: "The Artist",          color: "#6b4a6b" },
  { label: "Music Head",          color: "#3d6b5c" },
  { label: "Fashion Forward",     color: "#7a5c5c" },
  { label: "The Minimalist",      color: "#4a4a4a" },
  { label: "Dramatic Flair",      color: "#6b3d3d" },
  { label: "Ice Cold",            color: "#3d5c6b" },
  { label: "Hopeless Romantic",   color: "#7a4a5c" },
  { label: "The Athlete",         color: "#4a6b4a" },
  { label: "Science Brain",       color: "#3d4a6b" },
  { label: "Law & Order",         color: "#5c5c3d" },
  { label: "The Schemer",         color: "#4a3d5c" },
  { label: "Mysterious Aura",     color: "#3d3d5c" },
  { label: "Soft Life Only",      color: "#6b5c5c" },
];

export const XP_LEVELS = [
  { min: 0,     label: "Freshman",     icon: "📖" },
  { min: 500,   label: "Sophomore",    icon: "📚" },
  { min: 1500,  label: "Junior",       icon: "🎓" },
  { min: 3500,  label: "Senior",       icon: "🏛️" },
  { min: 7000,  label: "Graduate",     icon: "🎖️" },
  { min: 12000, label: "Honor Roll",   icon: "⭐" },
  { min: 20000, label: "Distinguished",icon: "🏆" },
  { min: 35000, label: "Legacy",       icon: "👑" },
];
export function getXPLevel(xp: number) {
  let lv = XP_LEVELS[0];
  for (const l of XP_LEVELS) { if (xp >= l.min) lv = l; }
  const nextIdx = XP_LEVELS.findIndex(l => l.min === lv.min) + 1;
  const next = XP_LEVELS[nextIdx];
  return { ...lv, xp, next: next?.min ?? null, progress: next ? (xp - lv.min) / (next.min - lv.min) : 1 };
}
