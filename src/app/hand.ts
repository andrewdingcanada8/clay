// A soft shadow of an adult male hand (right hand, palm down) lying on the ground
// plane as a scale reference. Dimensions in cm: ~19 cm wrist crease to middle
// fingertip, ~9 cm across the knuckles.

import * as THREE from 'three';

export const HAND_LENGTH_CM = 19;

const PX = 24; // texture pixels per cm
const W = 26, H = 30; // texture extent in cm (hand plus blur margin)

/** Hand outline drawn into ctx, in cm, wrist at (0,0), fingers toward -y (canvas up). */
function drawHand(ctx: CanvasRenderingContext2D) {
  const capsule = (x: number, y0: number, len: number, w: number, angleDeg = 0) => {
    ctx.save();
    ctx.translate(x, y0);
    ctx.rotate((angleDeg * Math.PI) / 180);
    const r = w / 2;
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(-r, -len + r);
    ctx.arc(0, -len + r, r, Math.PI, 0);
    ctx.lineTo(r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  // palm: slightly tapered toward the wrist, rounded corners
  ctx.beginPath();
  ctx.moveTo(-3.9, 0);
  ctx.bezierCurveTo(-4.6, -3, -4.7, -7, -4.4, -9.6);
  ctx.quadraticCurveTo(-4.2, -10.4, -3, -10.5);
  ctx.lineTo(3.2, -10.2);
  ctx.quadraticCurveTo(4.5, -10, 4.5, -8.8);
  ctx.bezierCurveTo(4.6, -6, 4.4, -2.5, 3.6, 0);
  ctx.closePath();
  ctx.fill();
  // fingers (index, middle, ring, little) from the knuckle line
  capsule(-3.2, -9.0, 8.1, 1.8, -7);
  capsule(-1.0, -9.6, 8.9, 1.85, -1.5);
  capsule(1.2, -9.4, 8.2, 1.75, 4);
  capsule(3.35, -8.5, 6.5, 1.6, 11);
  // thumb, angled out from the side of the palm
  capsule(-3.6, -2.4, 7.6, 2.3, -48);
  // wrist and the start of the forearm
  ctx.beginPath();
  ctx.moveTo(-3.9, -0.6);
  ctx.lineTo(-3.6, 5);
  ctx.lineTo(3.4, 5);
  ctx.lineTo(3.6, -0.6);
  ctx.closePath();
  ctx.fill();
}

function handTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = W * PX;
  c.height = H * PX;
  const ctx = c.getContext('2d')!;
  // Draw the hand off-canvas and keep only its blurred shadow (shadowBlur works
  // everywhere; ctx.filter does not).
  const off = c.width * 2;
  ctx.save();
  ctx.translate(-off, 0);
  ctx.shadowColor = 'rgba(0,0,0,1)';
  ctx.shadowBlur = 0.3 * PX;
  ctx.shadowOffsetX = off;
  ctx.translate((W / 2) * PX, (H - 7) * PX);
  ctx.scale(PX, PX);
  ctx.fillStyle = '#000';
  drawHand(ctx);
  ctx.restore();
  // fade the forearm out
  ctx.globalCompositeOperation = 'destination-out';
  const g = ctx.createLinearGradient(0, (H - 7.5) * PX, 0, (H - 2) * PX);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, (H - 7.5) * PX, c.width, 7.5 * PX);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class HandReference {
  readonly object: THREE.Mesh;
  private material: THREE.MeshBasicMaterial;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({ map: handTexture(), color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
    const geo = new THREE.PlaneGeometry(W, H);
    geo.rotateX(-Math.PI / 2); // lie flat; texture "up" (fingers) points to -Z
    // move the wrist (texture y = H-7) to the local origin
    geo.translate(0, 0, 7 - H / 2);
    this.object = new THREE.Mesh(geo, this.material);
    this.object.renderOrder = -1;
    this.object.visible = false; // shown once there is a piece to sit beside
  }

  setDark(dark: boolean) {
    this.material.opacity = dark ? 0.6 : 0.32;
  }

  /** Lay the hand on the ground beside the piece, fingers pointing away from the viewer. */
  place(box: THREE.Box3) {
    const groundY = box.min.y + 0.02;
    this.object.position.set(box.max.x + 3 + 8.6, groundY, (box.min.z + box.max.z) / 2 + 9.5);
  }

  /** World-space footprint (for framing the camera). */
  bounds(): THREE.Box3 {
    const p = this.object.position;
    return new THREE.Box3(new THREE.Vector3(p.x - 9, p.y, p.z - 19.5), new THREE.Vector3(p.x + 5, p.y + 0.1, p.z + 3));
  }
}
