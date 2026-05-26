import { Router, type IRouter } from "express";
import healthRouter from "./health";
import skipTraceRouter from "./skipTrace";

const router: IRouter = Router();

router.use(healthRouter);
router.use(skipTraceRouter);

export default router;
