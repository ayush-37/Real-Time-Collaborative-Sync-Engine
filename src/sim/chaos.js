// Fault injection: a WebSocket class that kills connections at awkward moments.
// Pass it to SyncClient as WebSocketImpl. Decisions come from a seeded rng.
//
// Two realistic ways a connection can die around a send (TCP does not drop messages on a LIVE connection):
//   lostBeforeSend : the connection dies, the message never leaves        -> only the resend can heal it
//   maybeDelivered : the message is written, THEN the connection dies    -> the server may have it,
//                    the client cannot know -> the resend creates a duplicate the server must absorb
import { WebSocket as WS } from 'ws';

export function makeChaos({ rng, killChance = 0.05, lifetimeKillMs = 0 }) {
  const stats = { sends: 0, kills: 0, lostBeforeSend: 0, maybeDelivered: 0, lifetimeKills: 0 };
  let enabled = true;

  class ChaosSocket extends WS {
    constructor(url) {
      super(url);
      if (enabled && lifetimeKillMs > 0) {
        // also die at a random moment even if nothing is being sent (e.g. while receiving)
        const timer = setTimeout(() => { stats.lifetimeKills++; this.terminate(); }, rng.int(lifetimeKillMs));
        this.on('close', () => clearTimeout(timer));
      }
    }

    send(data, ...rest) {
      stats.sends++;
      if (enabled && rng.chance(killChance)) {
        stats.kills++;
        if (rng.chance(0.5)) {
          stats.maybeDelivered++;
          super.send(data, () => this.terminate()); // written, then the connection dies
        } else {
          stats.lostBeforeSend++;
          this.terminate();                         // dies before anything leaves
        }
        return;
      }
      super.send(data, ...rest);
    }
  }

  return { Socket: ChaosSocket, stats, stop() { enabled = false; } };
}