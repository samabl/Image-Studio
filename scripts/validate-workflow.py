"""校验 GitHub Actions 工作流 YAML 的结构（本地预检，避免推到远端才发现语法错）。"""
import json
import sys

import yaml

PATH = ".github/workflows/build.yml"

with open(PATH, encoding="utf-8") as fh:
    doc = yaml.safe_load(fh)

print("YAML 解析成功")

# YAML 1.1 会把裸 on: 解析成布尔 True，两种键名都兼容一下
triggers = doc.get("on") or doc.get(True)
print("触发器:", list(triggers.keys()))

jobs = doc["jobs"]
print("jobs:", list(jobs.keys()))

ok = True
for name, job in jobs.items():
    steps = job.get("steps", [])
    print("  {}: runs-on={} steps={}".format(name, job.get("runs-on"), len(steps)))
    if "strategy" in job:
        print("    matrix:", json.dumps(job["strategy"].get("matrix"), ensure_ascii=False))
    for s in steps:
        if "uses" in s:
            print("    - uses:", s["uses"])
        elif "run" in s:
            first = s["run"].strip().splitlines()[0]
            print("    - run:", first[:70])
        else:
            print("    - (未知步骤)", s)
            ok = False

# 每个 job 都必须至少有一个 run 步骤，否则说明结构写歪了
for name, job in jobs.items():
    if not any("run" in s for s in job.get("steps", [])):
        print("警告: job {} 没有任何 run 步骤".format(name))
        ok = False

print("结构检查:", "通过" if ok else "有问题")
sys.exit(0 if ok else 1)
