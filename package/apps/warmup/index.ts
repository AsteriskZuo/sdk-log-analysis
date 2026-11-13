import { sdk } from "@asteriskzuo/agent-sdk";
import { loadRepoRegistry } from "../../packages/repos.js";
import { runWarmup, trySecretOf } from "../../packages/warmup.js";

// 仓预热程序（平台定时任务规则触发的无事件 run，main-only 阶段；薄壳，apps/ 布局：
// 实现代码归 packages/）：读信封（secrets/cacheDir）→ runWarmup 遍历登记表逐仓预热
// → 唯一出口。平台对该类 run 只跑 main 阶段（main-only），合成事件本程序不消费。
// 失败语义（多仓登记表 spec §4.3）：登记表加载失败（必要输入缺失）= 整体失败
// （sdk.fail）；单仓失败 = warn 留痕继续下一仓，不整体失败。
try {
  const result = await runWarmup({
    repos: () => loadRepoRegistry().repos,
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
