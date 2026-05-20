import { Router, type IRouter } from "express";
import healthRouter from "./health";
import postsRouter from "./posts";
import bidsRouter from "./bids";
import messagesRouter from "./messages";
import storageRouter from "./storage";
import walletRouter from "./wallet";
import npcRouter from "./npc";
import authRouter from "./auth";
import auctionsRouter from "./auctions";
import migrateRouter from "./migrate";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(migrateRouter);
router.use(postsRouter);
router.use(bidsRouter);
router.use(messagesRouter);
router.use(storageRouter);
router.use(walletRouter);
router.use(npcRouter);
router.use(auctionsRouter);

export default router;
