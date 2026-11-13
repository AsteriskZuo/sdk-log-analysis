import { sdk } from "@asteriskzuo/agent-sdk";
import { runWarmup, trySecretOf } from "../../packages/warmup.js";

// 仓预热程序（平台定时任务规则触发的无事件 run，spec §4.8/D10；薄壳，apps/ 布局：
// 实现代码归 packages/）：读信封（config/secrets/cacheDir）→ runWarmup → 唯一出口。
// 平台对该类 run 只跑 main 阶段（main-only），合成事件本程序不消费。
// 失败语义机械：任何一步失败 = 整体失败（sdk.fail）。
try {
  const result = await runWarmup({
    config: sdk.config,
    trySecret: trySecretOf(sdk.secret),
    cacheDir: sdk.cacheDir,
    log: sdk.log,
  });
  sdk.return(result);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  sdk.log("error", "仓预热失败", { errorMessage: message });
  sdk.fail(`仓预热失败：${message}`);
}
