import { useState } from "react";
import { Field, Panel, Switch } from "./ui";
import { ModelPicker } from "./ModelPicker";
import { useConfig, useToast } from "../lib/store";
import { listModels } from "../lib/api";
import { uid } from "../lib/image";
import { JURY_PROTOCOLS, MAX_JURY_MEMBERS, juryConnection, jurySettings } from "../lib/jury";
import type { ChatProtocol, JuryMemberConfig } from "../types";

export function JurySettings() {
  const cfg = useConfig((state) => state.config);
  const [loading, setLoading] = useState<string | null>(null);
  if (!cfg) return null;
  const jury = jurySettings(cfg.jury);
  const flush = () => void useConfig.getState().flush();
  const patch = (id: string, value: Partial<JuryMemberConfig>) => {
    const current = jurySettings(useConfig.getState().config?.jury);
    useConfig.getState().patchJury({ members: current.members.map((member) => member.id === id ? { ...member, ...value } : member) });
  };
  const fetchModels = async (member: JuryMemberConfig) => {
    const connection = juryConnection(member, cfg);
    if (!connection.baseUrl.trim() || !connection.apiKey.trim()) {
      useToast.getState().push("error", "请先填写评审连接的地址和 API Key"); return;
    }
    setLoading(member.id);
    try {
      const models = await listModels(connection.baseUrl, connection.apiKey, connection.protocol);
      patch(member.id, { models }); flush();
      useToast.getState().push(models.length ? "success" : "error", models.length ? `获取到 ${models.length} 个模型` : "没有返回模型");
    } catch (error) { useToast.getState().push("error", (error as Error).message); }
    finally { setLoading(null); }
  };
  return <Panel title={`评审团${jury.enabled ? " · 已开启" : ""}`} className="settings-panel">
    <div className="settings-stack">
      <Switch checked={jury.enabled} label="启用评审团" onChange={(enabled) => { useConfig.getState().patchJury({ enabled }); flush(); }} />
      <Switch checked={jury.includeChat} label={`Chat 也参与独立评审（${cfg.chat.model || "未配置"}）`}
        onChange={(includeChat) => { useConfig.getState().patchJury({ includeChat }); flush(); }} />
      <p className="hint">对话最终成图自动送审，Chat 汇总意见；每位启用的评审会增加一次请求，图片会发送给其配置的服务。</p>
      {jury.members.map((member, index) => <Panel key={member.id} defaultOpen className="jury-member" title={`${member.enabled ? "●" : "○"} ${member.name || `评审 ${index + 1}`} · ${member.model || "待配置"}`}>
        <div className="settings-stack">
          <div className="row">
            <Switch checked={member.enabled} label="参与评审" onChange={(enabled) => { patch(member.id, { enabled }); flush(); }} />
            <button type="button" className="btn sm danger" aria-label={`删除评审 ${member.name || index + 1}`} onClick={() => {
              const current = jurySettings(useConfig.getState().config?.jury);
              useConfig.getState().patchJury({ members: current.members.filter((item) => item.id !== member.id) }); flush();
            }}>删除</button>
          </div>
          <Field label="评审名称"><input className="input" aria-label={`评审 ${index + 1} 名称`} value={member.name}
            onChange={(event) => patch(member.id, { name: event.target.value })} onBlur={flush} /></Field>
          <Field label="识图模型" right={<button type="button" className="btn sm ghost" disabled={loading !== null} onClick={() => void fetchModels(member)}>{loading === member.id ? "获取中…" : "获取模型"}</button>}>
            <ModelPicker value={member.model} models={member.models.length ? member.models : member.inheritChat ? cfg.chat.models : []}
              onChange={(model) => patch(member.id, { model })} onBlur={flush} />
          </Field>
          <Field label="评审侧重点"><textarea className="textarea compact" aria-label={`评审 ${index + 1} 侧重点`} value={member.focus}
            placeholder="如文字准确性、人物结构、构图；留空全面评审" onChange={(event) => patch(member.id, { focus: event.target.value })} onBlur={flush} /></Field>
          <Switch checked={member.inheritChat} label="沿用对话连接" onChange={(inheritChat) => { patch(member.id, { inheritChat, models: [] }); flush(); }} />
          {!member.inheritChat && <div className="settings-stack">
            <Field label="协议"><select className="input" aria-label={`评审 ${index + 1} 协议`} value={member.protocol}
              onChange={(event) => { patch(member.id, { protocol: event.target.value as ChatProtocol, models: [] }); flush(); }}>
              {Object.entries(JURY_PROTOCOLS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></Field>
            <Field label="Base URL"><input className="input mono" aria-label={`评审 ${index + 1} Base URL`} value={member.baseUrl} autoComplete="off"
              onChange={(event) => patch(member.id, { baseUrl: event.target.value })} onBlur={flush} /></Field>
            <Field label="API Key"><input type="password" className="input mono" aria-label={`评审 ${index + 1} API Key`} value={member.apiKey} autoComplete="off"
              onChange={(event) => patch(member.id, { apiKey: event.target.value })} onBlur={flush} /></Field>
          </div>}
        </div>
      </Panel>)}
      <button type="button" className="btn sm" disabled={jury.members.length >= MAX_JURY_MEMBERS} onClick={() => {
        const current = jurySettings(useConfig.getState().config?.jury);
        if (current.members.length >= MAX_JURY_MEMBERS) return;
        useConfig.getState().patchJury({ members: [...current.members, {
          id: uid("jury"), name: `评审 ${current.members.length + 1}`, enabled: true, model: "", inheritChat: true,
          protocol: cfg.chat.protocol, baseUrl: "", apiKey: "", focus: "", models: [],
        }] }); flush();
      }}>＋ 添加识图评审</button>
      {jury.enabled && !jury.includeChat && !jury.members.some((member) => member.enabled) && <div className="err">至少启用一位评审。</div>}
    </div>
  </Panel>;
}
