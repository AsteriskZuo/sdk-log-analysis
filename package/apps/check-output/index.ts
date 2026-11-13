import {
  checkFields,
  checkMetrics,
  loadContract,
  sdk,
} from "@asteriskzuo/agent-sdk";

// 出口校验程序（平台三段编排第三阶段，保留程序名 check-output）：
// 校验主程序产出——失败 = run 失败且产出不扇出（企微出口与下游都收不到）。
//
// 条件必填逃生门（spec §9 决策点 D4 同型）：本业务 skip 路径（payload null /
// 非通过标题 / 自持过滤命中 / 去重命中 / 无日志）合法产出 null——契约里 content
// 等字段的 required 语义 = 「产出非空时必填」，v1 词表表达不了条件必填，故产出
// 为空（null / 结果行缺 output 键）时直接放行。
// metrics 校验同理只查非空产出：剥离点在 check-output 之后，此处看到的 output 仍含 metrics 键。
const { output } = sdk.input();
const contract = loadContract(
  new URL("../../../contract.json", import.meta.url),
);
if (contract.output !== null && output !== null && output !== undefined) {
  const problems = checkFields(contract.output.fields, output);
  problems.push(
    ...checkMetrics(
      contract.metrics?.fields ?? [],
      (output as { metrics?: Record<string, unknown> }).metrics,
    ),
  );
  if (problems.length > 0) sdk.fail(problems.join("；"));
}
sdk.return({});
