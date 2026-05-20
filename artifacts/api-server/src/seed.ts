import { db } from "@workspace/db";
import { postsTable, commentsTable, messagesTable } from "@workspace/db";
import { count, eq, inArray } from "drizzle-orm";

export async function ensureCharacterPosts() {
  const trentPost = {
    id: "p_trent_01",
    userId: "trent_morrison",
    username: "Trent Morrison",
    pic: "/trent_locker.jpeg",
    covenant: "blades",
    tier: "apex",
    content: "Post-practice. Nationals prep starts now.\n\nIf you're not in the pool before 5AM you're not on my team.\n\nWe don't lose. 🏊",
    image: "/trent_pool.webp",
    likes: 1840,
    skulls: 0,
    flames: 720,
  };
  const existing = await db.select({ id: postsTable.id }).from(postsTable).where(eq(postsTable.id, "p_trent_01")).limit(1);
  if (existing.length === 0) {
    await db.insert(postsTable).values(trentPost).onConflictDoNothing();
  }
}

export async function seedIfEmpty() {
  const [{ value }] = await db.select({ value: count() }).from(postsTable);
  if (value > 0) return;

  const posts = [
    {
      id: "p1", userId: "sebastian_blackwood", username: "Sebastian Blackwood", pic: "🦅", covenant: "crowns", tier: "apex",
      content: "Three generations of Blackwoods have walked these halls. The fourth has arrived.\n\nTo the Merit intake: brilliance without bloodline is borrowed time at Noctis.\n\nDon't waste it trying to impress us.",
      image: null, likes: 203, skulls: 88, flames: 45,
    },
    {
      id: "p2", userId: "ket_white", username: "Ket White", pic: "👑", covenant: "silk", tier: "apex",
      content: "Spring catalog is beautiful this year. 💎\n\nLot 7 is going to cause a bidding war. I can already tell.\n\nSome of you have no taste. The rest know exactly what I mean. 🦋",
      image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&q=80", likes: 612, skulls: 0, flames: 88,
    },
    {
      id: "p3", userId: "cordelia_vane", username: "Cordelia Vane", pic: "🌹", covenant: "silk", tier: "apex",
      content: "Pre-gala. Custom Vane-Ashcroft piece. The collar detail was my specification.\n\nMy two acquisitions will be attending on leash tonight. Symmetry matters. 🌹",
      image: "https://images.unsplash.com/photo-1566479179817-c0a63c6b6c3b?w=600&q=80", likes: 488, skulls: 0, flames: 0,
    },
    {
      id: "p5", userId: "isadora_mercer", username: "Isadora Mercer", pic: "👁️", covenant: "shadows", tier: "ascendant",
      content: "I've mapped the Burner Mode traffic for six weeks.\n\nSame writing patterns. Same posting times. Same network node.\n\nI know who the whisper is.\n\nI haven't decided what to do with that yet.",
      image: null, likes: 0, skulls: 410, flames: 220,
    },
    {
      id: "p6", userId: "vivienne_sterling", username: "Vivienne Sterling", pic: "✨", covenant: "silk", tier: "ascendant",
      content: "Spring Auction pre-gala fit check ✨\n\nSilk Covenant custom — don't ask where I got it, you can't afford the tailor.\n\nSee you all tonight 🌷",
      image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=600&q=80", likes: 380, skulls: 0, flames: 0,
    },
    {
      id: "p7", userId: "marcus_vale", username: "Marcus Vale", pic: "⚔️", covenant: "blades", tier: "ascendant",
      content: "Blades Covenant combat trials start Monday. If you're in, you know where.\n\nNo spectators. No mercy. We'll see who's left standing.",
      image: null, likes: 0, skulls: 180, flames: 155,
    },
    {
      id: "p8", userId: "elena_hart", username: "Elena Hart", pic: "🕯️", covenant: "shadows", tier: "merit",
      content: "Three weeks until end of semester.\n\nI need an 89 on Hargrove's final to stay out of the bottom 5%.\n\nSomeone in my study group disappeared last night. Her things are still in the room.",
      image: null, likes: 420, skulls: 680, flames: 0,
    },
    {
      id: "p9", userId: "dorian_ashford", username: "Dorian Ashford", pic: "🏛️", covenant: "crowns", tier: "apex",
      content: "Some things are worth owning properly.\n\nThe paperwork is clean. The collar is on.\n\nSemester ahead looks productive. 🏛️",
      image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&q=80", likes: 0, skulls: 280, flames: 0,
    },
    {
      id: "p10", userId: "remy_noire", username: "Remy Noire", pic: "🌑", covenant: "shadows", tier: "ascendant",
      content: "Data point: the same three professors have flagged students from the same dormitory two semesters running.\n\nPattern or policy?\n\nI'm asking for a friend.",
      image: null, likes: 0, skulls: 566, flames: 0,
    },
    {
      id: "p11", userId: "noah_park", username: "Noah Park", pic: "📚", covenant: "shadows", tier: "merit",
      content: "Merit survival tip #47: never let them see your grade notification popups.\n\nFace down. Always.\n\nThree weeks left. I'm going to make it.",
      image: null, likes: 560, skulls: 330, flames: 0,
    },
    {
      id: "p13", userId: "isolde_crane", username: "Isolde Crane", pic: "🎨", covenant: "silk", tier: "ascendant",
      content: "Tonight's piece — I call it \"Obedience Study in Silk.\" The subject is cooperative. The light is perfect.\n\nArt requires the right materials. 🎨",
      image: "https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=600&q=80", likes: 420, skulls: 0, flames: 0,
    },
    {
      id: "p14", userId: "vii_imperator", username: "[ Confession ]", pic: "👁️", covenant: "shadows", tier: "apex",
      content: "I sabotaged my roommate's exam submission. She was hovering at the 5% line.\n\nI needed her to fall, not me.\n\nShe got auctioned last week. I watched from the balcony.\n\nI will carry this forever.",
      image: null, likes: 0, skulls: 1240, flames: 680,
    },
    {
      id: "p15", userId: "lucian_vane", username: "Lucian Vane", pic: "💀", covenant: "crowns", tier: "apex",
      content: "The Vane name is the oldest at Noctis.\n\nEvery system here was built to serve people like us.\n\nThe question isn't whether you belong. The question is whether you're worth keeping.",
      image: null, likes: 0, skulls: 900, flames: 340,
    },
    {
      id: "p16", userId: "aurelia_vale", username: "Aurelia Vale", pic: "🌹", covenant: "silk", tier: "apex",
      content: "Four point two million followers outside this campus.\n\nI'm here because the credentials matter.\n\nEveryone here will matter to someone someday. The ones I choose, sooner. 🌹",
      image: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600&q=80", likes: 901, skulls: 310, flames: 0,
    },
    {
      id: "p17", userId: "sable_cross", username: "Sable Cross", pic: "🌑", covenant: "shadows", tier: "apex",
      content: "I see everything.\n\nI say nothing.\n\nI act accordingly.",
      image: null, likes: 0, skulls: 780, flames: 0,
    },
    {
      id: "p18", userId: "vii_imperator", username: "Vii Imperator", pic: "🎭", covenant: "shadows", tier: "apex",
      content: "Everything on this platform was built by me.\n\nEvery account. Every rule. Every consequence.\n\nBehave accordingly. 🎭",
      image: null, likes: 0, skulls: 2100, flames: 1200,
    },
  ];

  await db.insert(postsTable).values(posts).onConflictDoNothing();

  const comments = [
    { id: "c1", postId: "p1", userId: "victoria_ashford", username: "Victoria Ashford", text: "As always, Sebastian speaks the unpleasant truth.", parentId: null },
    { id: "c2", postId: "p1", userId: "anon_c2", username: "E. Montclair", text: "Legacy or not. Those words hit.", parentId: null },
    { id: "c3", postId: "p2", userId: "anon_c3", username: "V. Sterling", text: "The way you said that 🦋", parentId: null },
    { id: "c4", postId: "p2", userId: "vivienne_sterling", username: "Vivienne Sterling", text: "Already have my paddle ready 💎", parentId: null },
    { id: "c5", postId: "p2", userId: "anon_c5", username: "P. Nix", text: "Lot 7 is mine. I called it.", parentId: null },
    { id: "c6", postId: "p3", userId: "ket_white", username: "Ket White", text: "The collar detail. 💎 Stunning.", parentId: null },
    { id: "c7", postId: "p3", userId: "anon_c7", username: "Anonymous", text: "The way she said symmetry matters I cannot 😈", parentId: null },
    { id: "c10", postId: "p5", userId: "sebastian_blackwood", username: "Sebastian Blackwood", text: "My door is open. This stays private.", parentId: null },
    { id: "c11", postId: "p5", userId: "anon_c11", username: "Anonymous", text: "The way she said \"yet\" 😶 run.", parentId: null },
    { id: "c12", postId: "p6", userId: "ket_white", username: "Ket White", text: "Stunning. 💎 Save me a seat.", parentId: null },
    { id: "c13", postId: "p6", userId: "anon_c13", username: "M. Bellaire", text: "The fabric 😭 I'm not okay", parentId: null },
    { id: "c14", postId: "p7", userId: "anon_c14", username: "K. Rhodes", text: "Already bleeding and it hasn't started 😤 let's go", parentId: null },
    { id: "c15", postId: "p8", userId: "anon_c15", username: "Anonymous", text: "Don't let them see you scared. That's how they choose.", parentId: null },
    { id: "c16", postId: "p8", userId: "anon_c16", username: "Burner_88", text: "Warning network has your name on the safe list. Check Burner.", parentId: null },
    { id: "c17", postId: "p9", userId: "ket_white", username: "Ket White", text: "Welcome to it. 💎", parentId: null },
    { id: "c18", postId: "p9", userId: "anon_c18", username: "Anonymous", text: "The word \"productive\" 💀", parentId: null },
    { id: "c19", postId: "p10", userId: "elena_hart", username: "Elena Hart", text: "Which dorm.", parentId: null },
    { id: "c20", postId: "p10", userId: "remy_noire", username: "Remy Noire", text: "Check your Burner.", parentId: null },
    { id: "c21", postId: "p10", userId: "anon_c21", username: "Anonymous", text: "I live in that dorm. 💀", parentId: null },
    { id: "c22", postId: "p11", userId: "elena_hart", username: "Elena Hart", text: "Three weeks. We're both going to make it.", parentId: null },
    { id: "c23", postId: "p11", userId: "anon_c23", username: "Anonymous", text: "Rooting for you both. Stay safe.", parentId: null },
    { id: "c24", postId: "p13", userId: "cordelia_vane", username: "Cordelia Vane", text: "The light in this is extraordinary.", parentId: null },
    { id: "c25", postId: "p13", userId: "anon_c25", username: "Anonymous", text: "\"cooperative subject\" is doing so much work in that sentence 💀", parentId: null },
    { id: "c26", postId: "p14", userId: "anon_c26", username: "Anonymous", text: "This place does things to people.", parentId: null },
    { id: "c27", postId: "p14", userId: "anon_c27", username: "Anonymous", text: "We all have a price. You paid yours early.", parentId: null },
    { id: "c28", postId: "p15", userId: "anon_c28", username: "Anonymous", text: "This is the truth no one says out loud.", parentId: null },
    { id: "c29", postId: "p16", userId: "sebastian_blackwood", username: "Sebastian Blackwood", text: "The ones she chooses do tend to shine.", parentId: null },
    { id: "c30", postId: "p18", userId: "ket_white", username: "Ket White", text: "Noted. 👑", parentId: null },
    { id: "c31", postId: "p18", userId: "anon_c31", username: "Anonymous", text: "I genuinely don't know if I should be scared or grateful.", parentId: null },
  ];

  await db.insert(commentsTable).values(comments).onConflictDoNothing();

  const dms = [
    { id: "dm1", fromId: "ket_white", fromUsername: "Ket White", fromPic: "👑", toId: "sebastian_blackwood", toUsername: "Sebastian Blackwood", text: "Lot 7 is going to you. I've already decided." },
    { id: "dm2", fromId: "sebastian_blackwood", fromUsername: "Sebastian Blackwood", fromPic: "🦅", toId: "ket_white", toUsername: "Ket White", text: "I know. I'm not going to fight you for it." },
    { id: "dm3", fromId: "ket_white", fromUsername: "Ket White", fromPic: "👑", toId: "sebastian_blackwood", toUsername: "Sebastian Blackwood", text: "Smart. What did you think of the opening night? The Merit intake looked terrified." },
    { id: "dm4", fromId: "sebastian_blackwood", fromUsername: "Sebastian Blackwood", fromPic: "🦅", toId: "ket_white", toUsername: "Ket White", text: "Good. They should be. Fear is productive here." },
    { id: "dm5", fromId: "vii_imperator", fromUsername: "Vii Imperator", fromPic: "🎭", toId: "aurelia_vale", toUsername: "Aurelia Vale", text: "Your reach outside campus is useful. I want a conversation." },
    { id: "dm6", fromId: "aurelia_vale", fromUsername: "Aurelia Vale", fromPic: "🌹", toId: "vii_imperator", toUsername: "Vii Imperator", text: "My calendar is full. But for you, I'll make space." },
    { id: "dm7", fromId: "vii_imperator", fromUsername: "Vii Imperator", fromPic: "🎭", toId: "aurelia_vale", toUsername: "Aurelia Vale", text: "Thursday. West Wing. Come alone." },
    { id: "dm8", fromId: "aurelia_vale", fromUsername: "Aurelia Vale", fromPic: "🌹", toId: "vii_imperator", toUsername: "Vii Imperator", text: "Always. 🌹" },
    { id: "dm9", fromId: "lucian_vane", fromUsername: "Lucian Vane", fromPic: "💀", toId: "ket_white", toUsername: "Ket White", text: "Your position on the bid committee — I need your vote aligned with mine on Lot 12." },
    { id: "dm10", fromId: "ket_white", fromUsername: "Ket White", fromPic: "👑", toId: "lucian_vane", toUsername: "Lucian Vane", text: "And what does my vote cost?" },
    { id: "dm11", fromId: "lucian_vane", fromUsername: "Lucian Vane", fromPic: "💀", toId: "ket_white", toUsername: "Ket White", text: "Name it." },
    { id: "dm12", fromId: "sable_cross", fromUsername: "Sable Cross", fromPic: "🌑", toId: "vii_imperator", toUsername: "Vii Imperator", text: "I have something. Not for screens." },
    { id: "dm13", fromId: "vii_imperator", fromUsername: "Vii Imperator", fromPic: "🎭", toId: "sable_cross", toUsername: "Sable Cross", text: "East library. Basement level. Midnight." },
    { id: "dm14", fromId: "elena_hart", fromUsername: "Elena Hart", fromPic: "🕯️", toId: "noah_park", toUsername: "Noah Park", text: "Are you okay? You didn't show up to the study session." },
    { id: "dm15", fromId: "noah_park", fromUsername: "Noah Park", fromPic: "📚", toId: "elena_hart", toUsername: "Elena Hart", text: "I'm fine. I needed to not be seen for a while. You understand." },
    { id: "dm16", fromId: "elena_hart", fromUsername: "Elena Hart", fromPic: "🕯️", toId: "noah_park", toUsername: "Noah Park", text: "I understand. Three weeks. We're going to make it." },
  ];

  await db.insert(messagesTable).values(dms).onConflictDoNothing();
}
