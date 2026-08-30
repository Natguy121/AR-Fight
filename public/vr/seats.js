import * as THREE from '../vendor/three.module.js';
import { Panel, roundRect, fitText } from './paint.js';
import { TABLE } from './villa.js';

/**
 * Everyone else at the table.
 *
 * Seats are assigned **relative to you**: whoever you are, you are at angle
 * zero, and the rest of the table is dealt out clockwise from there. The
 * server has no concept of where anyone is sitting and does not need one —
 * seating is a presentation detail, and deriving it locally means two players
 * in the same room each see themselves at the near edge of the table, which
 * is the only arrangement that feels right from inside a headset.
 *
 * The one thing that is *not* a presentation detail: a player's role only
 * appears over their head when `viewFor` has already made it public — when
 * they are out, or at the reveal. This file never decides what may be shown,
 * it only draws what the server chose to send.
 */

/** A stable, distinct colour per player, from their id. */
function colourFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = (hash % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.42, 0.52);
}

function makeAvatar(colour) {
  const group = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a984, roughness: 0.7 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 6, 16), cloth);
  torso.position.y = 0.78;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 16), skin);
  head.position.y = 1.09;
  head.castShadow = true;
  group.add(head);

  // Shoulders, as a hint of arms resting on the table. Anything more
  // articulated would need pose data nobody is sending.
  for (const x of [-0.2, 0.2]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.2, 4, 10), cloth);
    arm.position.set(x, 0.8, 0.06);
    arm.rotation.set(-0.5, 0, x > 0 ? -0.25 : 0.25);
    arm.castShadow = true;
    group.add(arm);
  }

  group.userData.parts = { torso, head };
  return group;
}

export class Seating {
  constructor(parent) {
    this.root = new THREE.Group();
    parent.add(this.root);
    /** @type {Map<string, object>} playerId -> seat objects */
    this.seats = new Map();
    /** Panels that should turn to face the viewer each frame. */
    this.billboards = [];
    /** Meshes a vote ray can hit, tagged with userData.voteTargetId. */
    this.voteTargets = [];
    this.myId = null;
  }

  _makeSeat(player) {
    const group = new THREE.Group();
    const colour = colourFor(player.id);
    const avatar = makeAvatar(colour);
    group.add(avatar);

    const nameplate = new Panel({ width: 0.34, height: 0.11, ppm: 1300 });
    nameplate.mesh.position.y = 1.46;
    group.add(nameplate.mesh);

    const hint = new Panel({ width: 0.3, height: 0.11, ppm: 1300 });
    hint.mesh.position.set(0, 1.29, 0);
    group.add(hint.mesh);

    const vote = new Panel({ width: 0.26, height: 0.095, ppm: 1300 });
    vote.mesh.position.set(0, 1.0, 0.36);
    vote.mesh.userData.voteTargetId = player.id;
    vote.mesh.visible = false;
    group.add(vote.mesh);

    this.root.add(group);
    const seat = { group, avatar, nameplate, hint, vote, colour };
    this.billboards.push(nameplate.mesh, hint.mesh, vote.mesh);
    this.seats.set(player.id, seat);
    return seat;
  }

  _dropSeat(id) {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.billboards = this.billboards.filter(
      (m) => m !== seat.nameplate.mesh && m !== seat.hint.mesh && m !== seat.vote.mesh,
    );
    this.root.remove(seat.group);
    seat.nameplate.dispose();
    seat.hint.dispose();
    seat.vote.dispose();
    this.seats.set(id, null);
    this.seats.delete(id);
  }

  /** Rebuild from a server view. Cheap enough to call on every state message. */
  update(state, myId) {
    this.myId = myId;
    const players = state.players ?? [];
    const mine = Math.max(0, players.findIndex((p) => p.id === myId));
    const n = Math.max(players.length, 1);

    for (const id of [...this.seats.keys()]) {
      if (!players.some((p) => p.id === id)) this._dropSeat(id);
    }

    this.voteTargets = [];

    players.forEach((player, i) => {
      // You are always at angle zero — the near edge of the table.
      const angle = ((i - mine + n) % n) / n * Math.PI * 2;
      const seat = this.seats.get(player.id) ?? this._makeSeat(player);
      const isMe = player.id === myId;

      seat.group.position.set(
        Math.sin(angle) * (TABLE.radius + 0.3),
        0,
        Math.cos(angle) * (TABLE.radius + 0.3),
      );
      seat.group.rotation.y = angle + Math.PI; // face the middle

      // You do not get to see your own body: with no tracked limbs it would
      // only ever be a mannequin sitting inside your head.
      seat.avatar.visible = !isMe;

      const out = player.playing && !player.alive;
      const away = !player.connected;
      seat.avatar.position.y = out ? -0.12 : 0;
      seat.avatar.rotation.z = out ? 0.12 : 0;
      for (const part of Object.values(seat.avatar.userData.parts)) {
        part.material.opacity = away ? 0.45 : 1;
        part.material.transparent = away;
      }

      this._paintNameplate(seat, player, state, isMe);
      this._paintHint(seat, player, state);
      this._paintVote(seat, player, state, isMe);
    });
  }

  _paintNameplate(seat, player, state, isMe) {
    const turn = player.id === state.turnPlayerId;
    const out = player.playing && !player.alive;
    seat.nameplate.redraw((ctx, w, h) => {
      roundRect(ctx, 0, 0, w, h, h * 0.28);
      ctx.fillStyle = turn ? 'rgba(255,194,71,0.94)' : 'rgba(20,14,10,0.82)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = turn ? '#ffe6b0' : 'rgba(246,236,220,0.22)';
      ctx.stroke();

      const ink = turn ? '#2a1e00' : (out ? 'rgba(232,220,200,0.5)' : '#f3ece2');
      const label = isMe ? `${player.name} (you)` : player.name;
      const size = fitText(ctx, label, w * 0.62, h * 0.42, 650);
      ctx.font = `650 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, h * 0.28, h * 0.5);

      ctx.textAlign = 'right';
      ctx.font = `650 ${h * 0.36}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = turn ? 'rgba(42,30,0,0.75)' : 'rgba(232,220,200,0.6)';
      ctx.fillText(String(player.score ?? 0), w - h * 0.28, h * 0.5);

      // A role is drawn only once the server has made it public.
      if (player.role) {
        const isWhite = player.role === 'mrwhite';
        const text = isWhite ? 'MR. WHITE' : 'CIVILIAN';
        ctx.font = `700 ${h * 0.2}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillStyle = isWhite ? '#ffd9a0' : 'rgba(232,220,200,0.55)';
        ctx.fillText(text, h * 0.28, h * 0.84);
      } else if (!player.connected) {
        ctx.font = `600 ${h * 0.2}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(232,220,200,0.45)';
        ctx.fillText('AWAY', h * 0.28, h * 0.84);
      }
    });
  }

  _paintHint(seat, player, state) {
    const last = [...(state.hints ?? [])].reverse().find((h) => h.playerId === player.id);
    const voted = state.phase === 'vote' && player.voted;
    if (!last && !voted) {
      seat.hint.mesh.visible = false;
      return;
    }
    seat.hint.mesh.visible = true;
    seat.hint.redraw((ctx, w, h) => {
      roundRect(ctx, 0, 0, w, h * 0.78, h * 0.2);
      ctx.fillStyle = 'rgba(246,236,220,0.95)';
      ctx.fill();
      // A little tail, so it reads as speech rather than a floating label.
      ctx.beginPath();
      ctx.moveTo(w * 0.44, h * 0.77);
      ctx.lineTo(w * 0.5, h * 0.95);
      ctx.lineTo(w * 0.56, h * 0.77);
      ctx.closePath();
      ctx.fill();

      const text = last ? last.text : 'voted';
      const size = fitText(ctx, text, w * 0.82, h * 0.46, 700);
      ctx.font = `700 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = last ? '#2a1d12' : '#7a6450';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h * 0.39);
    });
  }

  _paintVote(seat, player, state, isMe) {
    const canVote = state.phase === 'vote'
      && !isMe
      && player.playing && player.alive
      && state.you?.playing && state.you?.alive;
    seat.vote.mesh.visible = canVote;
    if (!canVote) return;

    this.voteTargets.push(seat.vote.mesh);
    const chosen = state.yourVote === player.id;
    seat.vote.redraw((ctx, w, h) => {
      roundRect(ctx, 2, 2, w - 4, h - 4, h * 0.3);
      ctx.fillStyle = chosen ? 'rgba(255,194,71,0.95)' : 'rgba(20,14,10,0.85)';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = chosen ? '#ffe6b0' : 'rgba(255,194,71,0.5)';
      ctx.stroke();

      const label = chosen ? '✓ your vote' : 'Vote';
      const size = fitText(ctx, label, w * 0.8, h * 0.42, 650);
      ctx.font = `650 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = chosen ? '#2a1e00' : '#ffc247';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, w / 2, h / 2);
    });
  }

  /** Keep every floating label square-on to the viewer. */
  faceCamera(camera) {
    for (const mesh of this.billboards) {
      if (mesh.visible) mesh.lookAt(camera.getWorldPosition(_look));
    }
  }
}

const _look = new THREE.Vector3();

export default Seating;
