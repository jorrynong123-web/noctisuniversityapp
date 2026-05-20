import { pgTable, text, integer, timestamp, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const postsTable = pgTable("posts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  pic: text("pic").default("🌑"),
  covenant: text("covenant").default("shadows"),
  tier: text("tier").default("commoner"),
  content: text("content").notNull(),
  image: text("image"),
  likes: integer("likes").default(0),
  skulls: integer("skulls").default(0),
  flames: integer("flames").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const commentsTable = pgTable("comments", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull(),
  parentId: text("parent_id"),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const bidsTable = pgTable("bids", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  amount: integer("amount").notNull(),
  lotId: text("lot_id").notNull(),
  lotName: text("lot_name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messagesTable = pgTable("messages", {
  id: text("id").primaryKey(),
  fromId: text("from_id").notNull(),
  fromUsername: text("from_username").notNull(),
  fromPic: text("from_pic").default("🌑"),
  toId: text("to_id").notNull(),
  toUsername: text("to_username").notNull(),
  text: text("text").notNull(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPostSchema = createInsertSchema(postsTable).omit({ createdAt: true, likes: true, skulls: true, flames: true });
export const insertCommentSchema = createInsertSchema(commentsTable).omit({ createdAt: true });
export const insertBidSchema = createInsertSchema(bidsTable).omit({ createdAt: true });
export const insertMessageSchema = createInsertSchema(messagesTable).omit({ createdAt: true });

export type Post = typeof postsTable.$inferSelect;
export type Comment = typeof commentsTable.$inferSelect;
export type Bid = typeof bidsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type InsertPost = z.infer<typeof insertPostSchema>;
export type InsertComment = z.infer<typeof insertCommentSchema>;
export type InsertBid = z.infer<typeof insertBidSchema>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export const auctionsTable = pgTable("umbra_auctions", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id").notNull(),
  subjectType: text("subject_type").notNull(), // "user" | "document" | "item"
  subjectName: text("subject_name").notNull(),
  subjectAvatar: text("subject_avatar").default("🌑"),
  subjectData: json("subject_data").$type<Record<string, unknown>>().default({}),
  status: text("status").default("active").notNull(),
  reason: text("reason").default("financial").notNull(), // "financial" | "reputation" | "item"
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endsAt: timestamp("ends_at").notNull(),
  startingBid: integer("starting_bid").default(500).notNull(),
  currentBid: integer("current_bid").default(0).notNull(),
  highestBidderId: text("highest_bidder_id"),
  highestBidderName: text("highest_bidder_name"),
  highestBidderCov: text("highest_bidder_cov"),
  bidCount: integer("bid_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const auctionBidsTable = pgTable("umbra_auction_bids", {
  id: text("id").primaryKey(),
  auctionId: text("auction_id").notNull(),
  bidderId: text("bidder_id").notNull(),
  bidderName: text("bidder_name").notNull(),
  bidderCov: text("bidder_cov").default("shadows"),
  amount: integer("amount").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usersTable = pgTable("umbra_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  salt: text("salt").notNull(),
  profile: json("profile").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type UmbraUser = typeof usersTable.$inferSelect;

export type Auction = typeof auctionsTable.$inferSelect;
export type AuctionBid = typeof auctionBidsTable.$inferSelect;
