import * as THREE from '../vendor/three.module.js';
import { PALETTE, tileTexture, plasterTexture } from './paint.js';

/**
 * The room: a warm evening in somebody's villa, with a round table in it.
 *
 * Every shape here is generated from primitives — there is not a single
 * downloaded model or photograph — because the whole point of this mode is
 * that it loads off the same free server as everything else. The budget that
 * buys is spent on the things the eye actually reads as "a real room": light
 * that comes from somewhere, wear and variation in the surfaces, and clutter
 * at the edges. A flawless grey room with a table in it would be cheaper
 * still, and would feel like a test scene.
 *
 * Everything is built with the **table at the local origin**, so the caller
 * can place the whole villa relative to where the player is sitting rather
 * than doing arithmetic against a room corner.
 */

/** Shared with the seating and UI code, which must agree on where the table
 *  edge is to within a few centimetres or people's elbows float. */
export const TABLE = {
  radius: 0.82,
  height: 0.73,
  topThickness: 0.055,
};

const ROOM = {
  half: 4.4,       // half-width of the (square) room
  ceiling: 3.4,
};

function makeArchHole(cx, width, sill, height) {
  const hw = width / 2;
  const straight = Math.max(0.01, height - hw);
  const path = new THREE.Path();
  path.moveTo(cx - hw, sill);
  path.lineTo(cx - hw, sill + straight);
  path.absarc(cx, sill + straight, hw, Math.PI, 0, true);
  path.lineTo(cx + hw, sill);
  path.closePath();
  return path;
}

/**
 * One wall, as a flat plaster panel with arches cut out of it.
 *
 * Cutting real holes (rather than faking them with dark rectangles) is what
 * lets the evening light outside actually read as *outside* — you can see the
 * sky plane through them, and the arch edges occlude it as you move your head.
 */
function makeWall({ arches = [] }, material) {
  const shape = new THREE.Shape();
  shape.moveTo(-ROOM.half, 0);
  shape.lineTo(ROOM.half, 0);
  shape.lineTo(ROOM.half, ROOM.ceiling);
  shape.lineTo(-ROOM.half, ROOM.ceiling);
  shape.closePath();
  for (const a of arches) shape.holes.push(makeArchHole(a.x, a.width, a.sill, a.height));

  const geometry = new THREE.ShapeGeometry(shape);
  // ShapeGeometry has no UVs worth speaking of for a tiling material, so give
  // it ones based on world size — otherwise the plaster stretches per-wall.
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / 2;
    uv[i * 2 + 1] = pos.getY(i) / 2;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return new THREE.Mesh(geometry, material);
}

/** A chair: four legs, a seat, and a slatted back. */
function makeChair() {
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.75 });
  const cushion = new THREE.MeshStandardMaterial({ color: PALETTE.cloth, roughness: 0.95 });

  const seatY = 0.45;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), cushion);
  seat.position.y = seatY;
  seat.castShadow = true;
  group.add(seat);

  const legGeo = new THREE.BoxGeometry(0.045, seatY, 0.045);
  for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x, seatY / 2, z);
    group.add(leg);
  }

  // The back sits on the far side from the table, so +z once the chair is
  // rotated to face inward.
  const postGeo = new THREE.BoxGeometry(0.05, 0.55, 0.05);
  for (const x of [-0.19, 0.19]) {
    const post = new THREE.Mesh(postGeo, wood);
    post.position.set(x, seatY + 0.27, 0.19);
    group.add(post);
  }
  for (const y of [0.18, 0.36, 0.52]) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.07, 0.028), wood);
    slat.position.set(0, seatY + y, 0.19);
    group.add(slat);
  }
  return group;
}

/** A potted plant, for the corners. Cheap, and the room is dead without them. */
function makePlant() {
  const group = new THREE.Group();
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.13, 0.3, 20),
    new THREE.MeshStandardMaterial({ color: PALETTE.pot, roughness: 0.85 }),
  );
  pot.position.y = 0.15;
  pot.castShadow = true;
  group.add(pot);

  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(0.155, 0.155, 0.02, 20),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1 }),
  );
  soil.position.y = 0.3;
  group.add(soil);

  const leafMat = new THREE.MeshStandardMaterial({
    color: PALETTE.leaf, roughness: 0.8, side: THREE.DoubleSide,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: PALETTE.leafDark, roughness: 0.8, side: THREE.DoubleSide,
  });
  for (let i = 0; i < 11; i++) {
    const t = i / 11;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), i % 3 ? leafMat : darkMat);
    leaf.scale.set(0.42, 1.5, 0.42);
    const angle = t * Math.PI * 2 * 1.6;
    const lean = 0.12 + t * 0.16;
    leaf.position.set(Math.cos(angle) * lean, 0.42 + t * 0.5, Math.sin(angle) * lean);
    leaf.rotation.set(Math.sin(angle) * 0.5, angle, Math.cos(angle) * 0.5);
    leaf.castShadow = true;
    group.add(leaf);
  }
  return group;
}

/**
 * The world outside the arches: a warm sky over soft hills.
 *
 * A single painted plane a long way back. It never needs to hold up to
 * scrutiny — you only ever see slices of it through an arch — but without it
 * the arches are holes onto black, which reads as a set rather than a house.
 */
function makeOutside() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, '#7fa9cc');
  sky.addColorStop(0.45, '#e8b98a');
  sky.addColorStop(0.72, '#f0a463');
  sky.addColorStop(1, '#c97c4c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const sun = ctx.createRadialGradient(700, 300, 8, 700, 300, 190);
  sun.addColorStop(0, 'rgba(255,241,200,0.95)');
  sun.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Hills, back to front, each darker and hazier than the last.
  const hills = [
    { y: 330, h: 60, color: 'rgba(120,132,120,0.55)' },
    { y: 368, h: 70, color: 'rgba(94,110,90,0.7)' },
    { y: 408, h: 90, color: 'rgba(66,84,62,0.9)' },
  ];
  for (const hill of hills) {
    ctx.fillStyle = hill.color;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    ctx.lineTo(0, hill.y);
    for (let x = 0; x <= canvas.width; x += 32) {
      ctx.lineTo(x, hill.y + Math.sin(x * 0.006 + hill.h) * 22 + Math.sin(x * 0.017) * 11);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    ctx.fill();
  }

  // A few cypresses on the near ridge — the one silhouette that says "villa".
  ctx.fillStyle = 'rgba(40,56,38,0.95)';
  for (const [x, h] of [[150, 105], [205, 78], [800, 92], [845, 120], [880, 70]]) {
    ctx.beginPath();
    ctx.ellipse(x, 430 - h / 2, 13, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 17),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide }),
  );
  return mesh;
}

/**
 * Build the villa.
 *
 * @param {number} seatCount how many chairs to set around the table
 * @returns {{group: THREE.Group, lamp: THREE.PointLight, setSeatCount: Function}}
 */
export function buildVilla(seatCount = 6) {
  const group = new THREE.Group();

  // ---------------------------------------------------------------- shell

  const floorTex = tileTexture();
  floorTex.repeat.set(6, 6);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.half * 2, ROOM.half * 2),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.72 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  const plasterTex = plasterTexture();
  plasterTex.repeat.set(1, 1);
  const wallMat = new THREE.MeshStandardMaterial({
    map: plasterTex, color: PALETTE.plaster, roughness: 0.95, side: THREE.DoubleSide,
  });

  // Two glazed-less arcades facing the view, two solid walls behind.
  const arcade = {
    arches: [
      { x: -2.2, width: 1.5, sill: 0.45, height: 1.85 },
      { x: 0, width: 1.5, sill: 0.45, height: 1.85 },
      { x: 2.2, width: 1.5, sill: 0.45, height: 1.85 },
    ],
  };
  const walls = [
    { spec: arcade, pos: [0, 0, -ROOM.half], rot: 0 },
    { spec: arcade, pos: [ROOM.half, 0, 0], rot: -Math.PI / 2 },
    { spec: { arches: [{ x: 0, width: 1.35, sill: 0, height: 2.3 }] }, pos: [0, 0, ROOM.half], rot: Math.PI },
    { spec: { arches: [] }, pos: [-ROOM.half, 0, 0], rot: Math.PI / 2 },
  ];
  for (const w of walls) {
    const mesh = makeWall(w.spec, wallMat);
    mesh.position.set(...w.pos);
    mesh.rotation.y = w.rot;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  for (const [pos, rot] of [[[0, 0, -14], 0], [[14, 0, 0], -Math.PI / 2]]) {
    const outside = makeOutside();
    outside.position.set(pos[0], 3.2, pos[2]);
    outside.rotation.y = rot;
    group.add(outside);
  }

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.half * 2, ROOM.half * 2),
    new THREE.MeshStandardMaterial({ color: PALETTE.plasterShade, roughness: 1 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM.ceiling;
  group.add(ceiling);

  const beamMat = new THREE.MeshStandardMaterial({ color: PALETTE.beam, roughness: 0.85 });
  for (let i = -3; i <= 3; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, ROOM.half * 2), beamMat);
    beam.position.set(i * 1.25, ROOM.ceiling - 0.11, 0);
    beam.castShadow = true;
    group.add(beam);
  }

  // ----------------------------------------------------------- furniture

  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(2.05, 48),
    new THREE.MeshStandardMaterial({ color: PALETTE.rug, roughness: 1 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.004;
  rug.receiveShadow = true;
  group.add(rug);

  const rugTrim = new THREE.Mesh(
    new THREE.RingGeometry(1.82, 1.96, 48),
    new THREE.MeshStandardMaterial({ color: PALETTE.rugTrim, roughness: 1 }),
  );
  rugTrim.rotation.x = -Math.PI / 2;
  rugTrim.position.y = 0.006;
  group.add(rugTrim);

  const woodMat = new THREE.MeshStandardMaterial({ color: PALETTE.woodLight, roughness: 0.55 });
  const darkWoodMat = new THREE.MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.7 });

  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(TABLE.radius, TABLE.radius, TABLE.topThickness, 64),
    woodMat,
  );
  top.position.y = TABLE.height - TABLE.topThickness / 2;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  // A pedestal rather than legs: four legs and six chairs fight each other,
  // and someone always ends up with a leg through their knees.
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.17, TABLE.height - 0.1, 24), darkWoodMat);
  column.position.y = (TABLE.height - 0.1) / 2;
  column.castShadow = true;
  group.add(column);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.07, 32), darkWoodMat);
  foot.position.y = 0.035;
  foot.castShadow = true;
  group.add(foot);

  const chairs = new THREE.Group();
  group.add(chairs);

  function setSeatCount(n) {
    chairs.clear();
    const count = Math.max(3, n);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const chair = makeChair();
      chair.position.set(Math.sin(angle) * (TABLE.radius + 0.36), 0, Math.cos(angle) * (TABLE.radius + 0.36));
      chair.rotation.y = angle; // the back faces outward
      chairs.add(chair);
    }
  }
  setSeatCount(seatCount);

  for (const [x, z] of [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5]]) {
    const plant = makePlant();
    plant.position.set(x, 0, z);
    group.add(plant);
  }

  // A sideboard against the solid wall, with a bowl on it. Pure set dressing,
  // and the room looks abandoned without something along that wall.
  const sideboard = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.82, 0.45), darkWoodMat);
  sideboard.position.set(-ROOM.half + 0.3, 0.41, 0.4);
  sideboard.rotation.y = Math.PI / 2;
  sideboard.castShadow = true;
  group.add(sideboard);
  const bowl = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: PALETTE.brass, roughness: 0.35, metalness: 0.6 }),
  );
  bowl.rotation.x = Math.PI;
  bowl.position.set(-ROOM.half + 0.3, 0.9, 0.4);
  group.add(bowl);

  // ------------------------------------------------------------- lighting

  const hemi = new THREE.HemisphereLight(PALETTE.skyHigh, PALETTE.terracotta, 0.55);
  group.add(hemi);
  group.add(new THREE.AmbientLight(PALETTE.glow, 0.35));

  // The evening sun, coming in through the arcade at a low angle.
  const sun = new THREE.DirectionalLight(0xffc98a, 1.5);
  sun.position.set(7, 4.2, -7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 22;
  sun.shadow.camera.left = -5;
  sun.shadow.camera.right = 5;
  sun.shadow.camera.top = 5;
  sun.shadow.camera.bottom = -5;
  sun.shadow.bias = -0.0012;
  group.add(sun);
  group.add(sun.target);

  // The pendant over the table — the light that actually makes it feel like a
  // table you are sitting at, rather than a room you are standing in. Hung
  // high enough to clear a seated eyeline: at head height it is a glowing
  // blob parked in the middle of everyone's face.
  const lampY = 2.3;
  const flex = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, ROOM.ceiling - lampY, 6),
    new THREE.MeshStandardMaterial({ color: 0x2c2118 }),
  );
  flex.position.y = (ROOM.ceiling + lampY) / 2;
  group.add(flex);

  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.3, 0.26, 28, 1, true),
    new THREE.MeshStandardMaterial({
      color: PALETTE.brass, roughness: 0.4, metalness: 0.55, side: THREE.DoubleSide,
    }),
  );
  shade.position.y = lampY;
  group.add(shade);

  // Tucked up inside the shade, and tone-mapped along with everything else —
  // an untone-mapped emissive sphere clips to a flat white disc that reads as
  // a hole in the ceiling rather than a bulb.
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.038, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd79a }),
  );
  bulb.position.y = lampY - 0.08;
  group.add(bulb);

  // Hung just below the rim of the shade rather than up inside it. Inside, at
  // a few centimetres from the cone, the inverse-square falloff puts a
  // blown-out white disc on the shade's inner face — which is nothing like a
  // lamp and, at the wide field of view a viewer uses, sits right at the top
  // of both eyes.
  // A spotlight aimed down, not a bare bulb.
  //
  // A point light here throws just as much light up as down, and a metre
  // above it is a ceiling: the result is a burnt-out white patch overhead
  // that a shade cannot fix, because a shade only blocks light if it casts a
  // shadow, and shadowing a light from a mesh it sits inside is fiddly and
  // expensive. A cone pointed at the table is what the shade is *for*, and it
  // gets the pool of light on the table with nothing spilled on the ceiling.
  const lamp = new THREE.SpotLight(PALETTE.glow, 26, 12, Math.PI / 3.4, 0.55, 2);
  lamp.position.y = lampY - 0.16;
  lamp.target.position.set(0, 0, 0);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.bias = -0.004;
  group.add(lamp);
  group.add(lamp.target);

  // Two sconces on the solid wall, to keep the far side of the room from
  // falling into a black pit.
  for (const z of [-2.2, 2.6]) {
    const sconce = new THREE.PointLight(0xffbe7a, 6, 6, 2);
    sconce.position.set(-ROOM.half + 0.35, 2.1, z);
    group.add(sconce);
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false }),
    );
    glass.position.copy(sconce.position);
    group.add(glass);
  }

  return { group, lamp, setSeatCount };
}

export default { buildVilla, TABLE };
