import { Router, type IRouter } from "express";
import healthRouter from "./health";
import skipTraceRouter from "./skipTrace";
import proxiesRouter from "./proxies";

const router: IRouter = Router();

router.use(healthRouter);
router.use(skipTraceRouter);
router.use(proxiesRouter);

export default router;
