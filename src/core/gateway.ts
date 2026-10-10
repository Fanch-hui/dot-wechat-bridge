import { Database } from "./database.ts";
import { Config } from "./config.ts";
import { hash, token } from "./security.ts";
import { requireValue } from "./errors.ts";
import { GatewayLease } from "../shared/contracts.ts";
import { Participants } from "./participants.ts";

interface GatewayRow {gateway_id:string;lease_hash:string;lease_until:number;cursor:string;status:string}
export class GatewayControl {
  constructor(readonly db: Database, readonly cfg: Config) {}
  async acquire(id: string, now: number, version=1): Promise<GatewayLease> {
    requireValue(version===1 || version===2,"gateway_protocol_invalid",400);
    const secret=token();
    const update=await this.db.run(`INSERT INTO gateway(id,gateway_id,lease_hash,lease_until,protocol_version)
      VALUES('personal',?,?,?,?) ON CONFLICT(id) DO UPDATE SET gateway_id=excluded.gateway_id,
      lease_hash=excluded.lease_hash,lease_until=excluded.lease_until,protocol_version=excluded.protocol_version
      WHERE gateway.lease_until<=? OR gateway.gateway_id=excluded.gateway_id`,
      [id,await hash(secret),now+this.cfg.gatewayLeaseMs,version,now]);
    requireValue(update.meta.changes===1,"gateway_already_running");
    const row=await this.db.one<GatewayRow>("SELECT * FROM gateway WHERE id='personal'");
    return {gateway_id:id,lease_token:secret,cursor:row!.cursor,lease_until:row!.lease_until};
  }
  async authorize(id: string, lease: string, now: number) {
    const row=await this.db.one<GatewayRow>("SELECT * FROM gateway WHERE id='personal'");
    const leaseHash=await hash(lease);
    requireValue(row?.gateway_id===id && row.lease_hash===leaseHash && row.lease_until>now,"gateway_lease_invalid");
    return leaseHash;
  }
  async tick(id: string, lease: string, now: number) {
    const leaseHash=await this.authorize(id,lease,now);
    await this.db.run("UPDATE gateway SET lease_until=? WHERE gateway_id=? AND lease_hash=?", [now+this.cfg.gatewayLeaseMs,id,leaseHash]);
    return {lease_until:now+this.cfg.gatewayLeaseMs};
  }
  async bind(sender: string, botId?:string) {
    return new Participants(this.db).bindLegacy(sender,botId);
  }
}
