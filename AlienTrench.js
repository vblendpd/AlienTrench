function StartGame(canvas) {
  'use strict';

  //getBoundingClientRect gives the CSS layout size affected by CSS scaling
  //write that size back to canvas so the pixel buffer matches the display area and doesn't look stretched
  const clientRect = canvas.getBoundingClientRect();
  const cssWidth = Math.round(clientRect.width) || canvas.offsetWidth || 720;
  const cssHeight = Math.round(clientRect.height) || canvas.offsetHeight || Math.round(cssWidth * 0.65);
  canvas.width = cssWidth;
  canvas.height = cssHeight;

  const ctx = canvas.getContext('2d');
  //save canvas area so every class can reference them without touching the HTML
  const CLIENT_WIDTH = canvas.width;
  const CLIENT_HEIGHT = canvas.height;

  canvas.style.display = 'block';
  canvas.style.cursor = 'crosshair';

  //draw all UI directly on the canvas
  const overlayState = {
    visible: true,       //whether the full-screen overlay is showing
    title: 'DIVE NOW',   //large heading text
    sub: 'Fight three waves of alien lifeforms and face the Leviathan',
  };

  //HUD state updated every frame in UI.Update()
  const hudState = {
    hp: 100,
    waveNum: 1,
    isBoss: false,
    powerupText: ''
  };

  //gTime counts frames since the last Start()
  //animations use it as a phase input so they pulse independently of any entity
  let gTime = 0;

  //renderer helpers
  const R = {
    //draw a small health bar centred horizontally at x,y
    //5px tall and colored by a ratio threshold: > 60% -> green, > 30% → orange, <= 30% -> red
    HealthBar(x, y, width, health, maxHealth) {
      const ratio = health / maxHealth; //normalize

      //dark rectangle so the bar is readable over background
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x - width / 2, y, width, 5);

      //horizontal gradient color shift by health level
      const grad = ctx.createLinearGradient(x - width / 2, 0, x + width / 2, 0);
      if (ratio > 0.6) {
        grad.addColorStop(0, '#0f0');  //green
        grad.addColorStop(1, '#8f0');
      } else if (ratio > 0.3) {
        grad.addColorStop(0, '#f80');  //orange
        grad.addColorStop(1, '#fa0');
      } else {
        grad.addColorStop(0, '#f00');  //red
        grad.addColorStop(1, '#f40');
      }
      ctx.fillStyle = grad;
      //only fill width*ratio so the rest stays as the dark background
      ctx.fillRect(x - width / 2, y, width * ratio, 5);

      //white border
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - width / 2, y, width, 5);
    }
  };

  //trace a regular polygon path centred at cx,cy
  //the +0.524 offset rotates the first vertex by PI/6 so a hexagon sits flat side-down (like a standard hex tile)
  function HexPath(cx, cy, size, sides) {
    ctx.beginPath();
    for (let i = 0; i <= sides; i++) {
      //divide the full circle evenly among the vertices
      const angle = i / sides * 6.28 + 0.524; //0.524 = PI/6
      i === 0 ? ctx.moveTo(cx + Math.cos(angle) * size, cy + Math.sin(angle) * size) :
        ctx.lineTo(cx + Math.cos(angle) * size, cy + Math.sin(angle) * size);
    }
    ctx.closePath();
  }

  //handle all raw browser event listeners so they can be removed when the game is shut down
  //coordinates are mapped from CSS to canvas pixels because the canvas may be scaled (HiDPI)
  class InputHandler {
    constructor() {
      this.keys = {};  //key name -> boolean (true while held)
      this.mouse = {x: CLIENT_WIDTH / 2, y: CLIENT_HEIGHT / 2, down: false};

      //arrow functions capture this from the constructor scope
      this._onKeyDown = e => {
        this.keys[e.key] = true;

        //prevent page scrolling when arrowKeys/space are used
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key))
          e.preventDefault();
      };
      this._onKeyUp = e => {
        this.keys[e.key] = false;
      };

      //convert CSS mouse position to canvas pixel space
      this._onMove = e => {
        const rect = canvas.getBoundingClientRect();
        this.mouse.x = (e.clientX - rect.left) * CLIENT_WIDTH / rect.width;
        this.mouse.y = (e.clientY - rect.top) * CLIENT_HEIGHT / rect.height;
      };
      this._onDown = e => {
        if (e.button === 0) this.mouse.down = true;
      };
      this._onUp = e => {
        if (e.button === 0) this.mouse.down = false;
      };

      //keyboard events go on document so the canvas doesn't need to be focused
      document.addEventListener('keydown', this._onKeyDown);
      document.addEventListener('keyup', this._onKeyUp);
      canvas.addEventListener('mousemove', this._onMove);
      canvas.addEventListener('mousedown', this._onDown);
      canvas.addEventListener('mouseup', this._onUp);
    }

    destroy() {
      document.removeEventListener('keydown', this._onKeyDown);
      document.removeEventListener('keyup', this._onKeyUp);
      canvas.removeEventListener('mousemove', this._onMove);
      canvas.removeEventListener('mousedown', this._onDown);
      canvas.removeEventListener('mouseup', this._onUp);
    }

    //returns true if any of the given key names is currently held
    IsDown(...keys) {
      return keys.some(k => this.keys[k]);
    }
  }

  //spark particle with radial-gradient halo and solid circle on top
  //each frame it moves by its velocity, which is damped by 0.93 (exponential friction)
  //alpha fades linearly
  class Particle {
    constructor(x, y, velX, velY, radius, lifetime, color) {
      this.x = x;
      this.y = y;
      this.velX = velX;
      this.velY = velY;
      this.radius = radius;
      this.lifetime = lifetime;
      this.maxLifetime = lifetime; //store this so we can compute fade ratio
      this.color = color;
    }

    //true once the particle has lived its full lifetime
    get Dead() {
      return this.lifetime <= 0;
    }

    Update() {
      this.x += this.velX;
      this.y += this.velY;
      this.velX *= 0.93;
      this.velY *= 0.93;
      this.lifetime--;
    }

    Draw() {
      ctx.save();
      //fraction of remaining lifetime
      ctx.globalAlpha = this.lifetime / this.maxLifetime;

      //outer glow a transparent radial gradient twice the core radius
      const glow = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.radius * 2);
      glow.addColorStop(0, this.color);
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius * 2, 0, 6.28);
      ctx.fill();

      //bright solid core drawn on top of the glow
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, 6.28);
      ctx.fill();
      ctx.restore();
    }
  }

  //entire live particle pool
  //particles are stored in a flat array
  //dead ones are filtered out each frame gc-friendly (no explicit free-list needed)
  class ParticleSystem {
    constructor() {
      this.list = [];
    }

    //spawns "count" particles in random directions
    //speed and lifetime are chosen uniformly within [min, max] ranges
    //a random color is picked from "colors" for each particle
    _Emit(x, y, count, colors, minSpeed, maxSpeed, minLifetime, maxLifetime, minRadius, maxRadius) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * 6.28;
        const speed = minSpeed + Math.random() * (maxSpeed - minSpeed);
        this.list.push(new Particle(
          x, y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          minRadius + Math.random() * (maxRadius - minRadius),
          minLifetime + ~~(Math.random() * (maxLifetime - minLifetime)),
          colors[~~(Math.random() * colors.length)]
        ));
      }
    }

    //small burst for bullet impacts
    Hit(x, y, color) {
      this._Emit(x, y, 6, [color], 1, 4, 15, 30, 2, 4);
    }

    //explosion when an enemy dies
    Death(x, y, type) {
      const palette = {
        jellyfish: ['#cc44ff', '#ff44cc', '#44ffcc'],
        puffer: ['#ffaa00', '#ff6600', '#00ccff'],
        anglerfish: ['#00ff88', '#44ffaa', '#aaff00'],
        baby_octopus: ['#ff8800', '#ffaa33', '#ff5500']
      }[type] || ['#fff'];
      this._Emit(x, y, 28, palette, 1, 7, 30, 60, 2, 6);
    }

    //boss death burst 90 particles
    BossDeath(x, y) {
      this._Emit(x, y, 90,
        ['#ff2060', '#ff60a0', '#fff', '#a020ff', '#ff8020', '#ffe060'],
        1, 10, 50, 120, 3, 8
      );
    }

    //remove dead ones without shifting the full array
    Update() {
      this.list = this.list.filter(p => {
        p.Update();
        return !p.Dead;
      });
    }

    Draw() {
      this.list.forEach(p => p.Draw());
    }
  }

  //40 small bubbles that float upward and move horizontally
  //bubble exits the top (y < -10) and recycled at the bottom
  //12 radial light blobs that oscillate in brightness
  class Background {
    constructor() {
      //each bubble has a random starting position, rise speed, wobble phase radius
      this.bubbles = Array.from({length: 40}, () => ({
        x: Math.random() * CLIENT_WIDTH,
        y: Math.random() * CLIENT_HEIGHT,
        radius: 1 + Math.random() * 4,
        speed: 0.2 + Math.random() * 0.5,   //pixels per frame upward
        wobblePhase: Math.random() * 6.28,  //randomize start of sin cycle
        alpha: 0.15 + Math.random() * 0.3
      }));

      this.caustics = Array.from({length: 12}, () => ({
        x: Math.random() * CLIENT_WIDTH,
        y: Math.random() * CLIENT_HEIGHT,
        radius: 40 + Math.random() * 80,
        phase: Math.random() * 6.28,
        speed: 0.003 + Math.random() * 0.004  //phase advance per frame
      }));
    }

    Update() {
      this.bubbles.forEach(b => {
        b.y -= b.speed;                       //float upward
        b.wobblePhase += 0.04;                //advance wobble oscillator
        b.x += Math.sin(b.wobblePhase) * 0.3; //gentle left-right drift

        //recycle bubble at the bottom
        if (b.y < -10) {
          b.y = CLIENT_HEIGHT + 10;
          b.x = Math.random() * CLIENT_WIDTH;
        }
      });
      //caustics only need their phase advanced as position never changes
      this.caustics.forEach(c => c.phase += c.speed);
    }

    Draw() {
      //ocean gradient black navy at top and almost black at bottom
      const bgGrad = ctx.createLinearGradient(0, 0, 0, CLIENT_HEIGHT);
      bgGrad.addColorStop(0, '#001428');
      bgGrad.addColorStop(1, '#000508');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, CLIENT_WIDTH, CLIENT_HEIGHT);

      //caustic light transparent
      this.caustics.forEach(c => {
        const alpha = 0.03 + 0.02 * Math.sin(c.phase); //oscillates between 0.01–0.05
        const cg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.radius);
        cg.addColorStop(0, `rgba(0,180,255,${alpha})`);
        cg.addColorStop(1, 'transparent');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.radius, 0, 6.28);
        ctx.fill();
      });

      //stroke circles with little fill so they look hollow
      this.bubbles.forEach(b => {
        ctx.save();
        ctx.globalAlpha = b.alpha;
        ctx.strokeStyle = 'rgba(150,230,255,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius, 0, 6.28);
        ctx.stroke();
        ctx.fillStyle = 'rgba(200,240,255,0.1)';
        ctx.fill();
        ctx.restore();
      });
    }
  }

  //shared class for both player and enemy projectiles
  //the owner string "player" and "enemy" is used by the draw code and collision logic
  //each trail segment is drawn progressively smaller and more transparent to create blur
  class Bullet {
    constructor(x, y, velX, velY, damage, lifetime, radius, color, owner) {
      this.x = x;
      this.y = y;
      this.velX = velX;
      this.velY = velY;
      this.damage = damage;
      this.lifetime = lifetime;
      this.radius = radius;
      this.color = color;
      this.owner = owner;   //"player" or "enemy"
      this.trail = [];      //ring buffer of x,y positions
      this.active = true;
    }

    Update() {
      this.x += this.velX;
      this.y += this.velY;
      this.lifetime--;

      //push current position to the front of the trail queue
      this.trail.unshift({x: this.x, y: this.y});

      //keep it at most 8 entries long by dropping the oldest
      if (this.trail.length > 8) this.trail.pop();

      //deactivate if the bullet leaves the playfield or dies
      if (this.x < -20 || this.x > CLIENT_WIDTH + 20 || this.y < -20 || this.y > CLIENT_HEIGHT + 20 || this.lifetime <= 0)
        this.active = false;
    }

    Draw() {
      const isPlayer = this.owner === 'player';

      //each older trail point is smaller and more transparent
      //i = 0 is the newest most opaque point and i = length-1 the oldest light
      this.trail.forEach((point, i) => {
        ctx.save();
        ctx.globalAlpha = (1 - i / this.trail.length) * (isPlayer ? 0.45 : 0.3);
        ctx.fillStyle = this.color;
        ctx.beginPath();
        //radius shrinks proportionally to position in the trail
        ctx.arc(point.x, point.y, this.radius * 0.7 * (1 - i / this.trail.length), 0, 6.28);
        ctx.fill();
        ctx.restore();
      });

      //glow around the bullet head
      const halo = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.radius * 2.5);
      //append "cc" (80% opacity) to the hex color string for the center stop
      halo.addColorStop(0, this.color + 'cc');
      halo.addColorStop(1, 'transparent');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius * 2.5, 0, 6.28);
      ctx.fill();

      //player bullets get a white core while enemy bullets keep their color
      ctx.fillStyle = isPlayer ? '#eefaff' : this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, 6.28);
      ctx.fill();
    }

    //returns true when the squared distance between centres is less than the
    Hits(target) {
      return this.active &&
        (this.x - target.x) ** 2 + (this.y - target.y) ** 2 <
        (target.radius + this.radius) ** 2;
    }
  }

  //a collectible pill that pops out of a killed enemy
  //starts with a random horizontal drift and a small upward impulse
  //each frame velY increases by 0.025 simulating gravity
  class Powerup {
    constructor(x, y, type) {
      this.x = x;
      this.y = y;
      this.type = type;                         //"shield" or "multi"
      this.radius = 14;                         //used for collision with player
      this.velX = (Math.random() - 0.5) * 0.8;  //random left/right
      this.velY = -0.6 - Math.random() * 0.4;   //initial upward impulse
      this.phase = Math.random() * 6.28;        //randomize glow start phase
      this.lifetime = 600;                      //frames before auto-despawn
      this.active = true;
    }

    Update() {
      this.x += this.velX;
      this.y += this.velY;
      this.velY += 0.025; //gravity
      this.phase += 0.06; //advance glow oscillation
      this.lifetime--;
      if (this.lifetime <= 0 || this.y > CLIENT_HEIGHT + 40)
        this.active = false;
    }

    Draw() {
      ctx.save();
      ctx.translate(this.x, this.y);

      //pulse factor oscillates between 0.8 and 1.0 to make the glow breathe
      const pulse = 0.8 + 0.2 * Math.sin(this.phase + gTime * 0.08);
      const color = this.type === 'shield' ? '#4090ff' : '#40ff80';

      //outer radial glow
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius * 2.5 * pulse);
      halo.addColorStop(0, color + '55'); //55 = 33% alpha
      halo.addColorStop(1, 'transparent');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 2.5 * pulse, 0, 6.28);
      ctx.fill();

      //pill body = a rounded rectangle built with arcTo
      const pw = this.radius * 2;
      const ph = this.radius;
      const cr = this.radius / 2;
      ctx.beginPath();
      ctx.moveTo(-pw / 2 + cr, -ph / 2);
      ctx.arcTo(pw / 2, -ph / 2, pw / 2, ph / 2, cr);
      ctx.arcTo(pw / 2, ph / 2, -pw / 2, ph / 2, cr);
      ctx.arcTo(-pw / 2, ph / 2, -pw / 2, -ph / 2, cr);
      ctx.arcTo(-pw / 2, -ph / 2, pw / 2, -ph / 2, cr);
      ctx.closePath();
      ctx.fillStyle = color + 'cc';
      ctx.fill();
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      //the icon
      ctx.fillStyle = '#fff';
      ctx.font = `${this.radius * 0.9}px Segoe UI`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.type === 'shield' ? '🛡' : '🔫', 0, 1);
      ctx.restore();
    }

    //circle–circle overlap with the player
    CollidesWith(player) {
      return (player.x - this.x) ** 2 + (player.y - this.y) ** 2 < (player.radius + this.radius) ** 2;
    }
  }

  //the player is a submarine sprite that always aims toward the mouse cursor
  class Player {
    constructor(x, y) {
      this.x = x;
      this.y = y;
      this.radius = 22;
      this.health = 100;
      this.maxHealth = 100;
      this.speed = 3.2;         //pixels per frame
      this.aimAngle = 0;        //angle toward mouse
      this.iFrames = 0;         //invincibility frame counter
      this.trail = [];          //motion-blur trail positions
      this.shieldActive = false;
      this.shieldTimer = 0;     //frames remaining on active shield
      this.multishot = false;
      this.multishotTimer = 0;  //frames remaining on multishot
      this.shootCooldown = 0;   //frames until next shot is allowed
    }

    //activate a collected powerup
    ApplyPowerup(type) {
      if (type === 'shield') {
        this.shieldActive = true;
        this.shieldTimer = 1200;    //20 seconds
      } else {
        this.multishot = true;
        this.multishotTimer = 1500; //25 seconds
      }
    }

    //returns a string describing what happened
    //"shield" = hit absorbed by shield (shield deactivated)
    //"dead"   = health reached 0
    //"hit"    = normal damage applied
    //iFrames prevent further damage for 50 frames after a hit and for 30 frames after a shield absorption
    TakeDamage(damage) {
      if (this.shieldActive) {
        this.shieldActive = false;  //shield soaks the hit at the cost of itself
        this.shieldTimer = 0;
        this.iFrames = 30;
        return 'shield';
      }
      this.health -= damage;
      this.iFrames = 50;
      return this.health <= 0 ? 'dead' : 'hit';
    }

    //produce one or three bullets depending on multishot state
    //bullets spawn at radius 32px from the player center so they don't immediately collide with the player
    Shoot() {
      const aimAngle = this.aimAngle;
      const aimAngles = this.multishot ? [aimAngle - 0.18, aimAngle, aimAngle + 0.18] : [aimAngle];

      //longer cooldown for multishot to compensate for triple damage potential
      this.shootCooldown = this.multishot ? 14 : 11;

      return aimAngles.map(angle => {
        const spread = (Math.random() - 0.5) * 0.03; //small random deviation

        //spawn position offset along the aim direction so the bullet starts just outside the player collision circle
        return new Bullet(this.x + Math.cos(angle) * 32,
          this.y + Math.sin(angle) * 32,
          Math.cos(angle + spread) * 10,
          Math.sin(angle + spread) * 10,
          18,       //damage
          55,       //lifetime (frames)
          3,        //visual radius
          '#00d4ff',
          'player');
      });
    }

    Update(input) {
      let moveX = 0, moveY = 0;
      if (input.IsDown('w', 'ArrowUp'))
        moveY--;
      if (input.IsDown('s', 'ArrowDown'))
        moveY++;
      if (input.IsDown('a', 'ArrowLeft'))
        moveX--;
      if (input.IsDown('d', 'ArrowRight'))
        moveX++;

      //normalize
      if (moveX || moveY) {
        const mag = Math.sqrt(moveX * moveX + moveY * moveY);
        moveX /= mag;
        moveY /= mag;
      }

      //clamp position inside the canvas bounds with a 20px margin
      this.x = Math.max(20, Math.min(CLIENT_WIDTH - 20, this.x + moveX * this.speed));
      this.y = Math.max(20, Math.min(CLIENT_HEIGHT - 20, this.y + moveY * this.speed));

      //aim angle atan2 gives the angle from player to mouse in radians
      this.aimAngle = Math.atan2(input.mouse.y - this.y, input.mouse.x - this.x);

      this.trail.unshift({x: this.x, y: this.y});
      if (this.trail.length > 18)
        this.trail.pop();

      if (this.iFrames > 0)
        this.iFrames--;

      if (this.shieldTimer > 0) {
        this.shieldTimer--;
        if (this.shieldTimer === 0)
          this.shieldActive = false;
      }
      if (this.multishotTimer > 0) {
        this.multishotTimer--;
        if (this.multishotTimer === 0)
          this.multishot = false;
      }
      if (this.shootCooldown > 0)
        this.shootCooldown--;
    }

    Draw() {
      const {x, y, aimAngle, iFrames, shieldActive, trail} = this;

      //wake trail
      trail.forEach((point, i) => {
        const fade = 1 - i / trail.length; // i = 0 -> fade = 1, oldest -> fade = 0
        ctx.save();
        ctx.globalAlpha = fade * 0.22;
        ctx.strokeStyle = 'rgba(120,220,255,0.9)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4 * fade, 0, 6.28);
        ctx.stroke();
        ctx.restore();
      });

      //shield bubble
      if (shieldActive) {
        //radial gradient from opaque at the player edge to transparent further out
        const sg = ctx.createRadialGradient(x, y, this.radius, x, y, this.radius + 22);
        sg.addColorStop(0, 'rgba(40,140,255,0.4)');
        sg.addColorStop(1, 'transparent');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(x, y, this.radius + 22, 0, 6.28);
        ctx.fill();

        //pulsing ring outline oscillates via sin
        ctx.strokeStyle = `rgba(80,180,255,${0.5 + 0.4 * Math.sin(gTime * 0.15)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, this.radius + 13, 0, 6.28);
        ctx.stroke();
      }

      //invincibility
      //while iFrames is counting down -> toggle visibility every 4 frames
      //floor(iFrames / 4) % 2 === 0 means "visible this 4-frame window"
      if (iFrames > 0 && Math.floor(iFrames / 4) % 2 === 0) {
        R.HealthBar(x, y - 36, 50, this.health, this.maxHealth);
        return; //skip drawing the body
      }

      //sprite (all geometry is drawn in local space)
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(aimAngle);

      //kick makes the pectoral fins flap.
      const kick = Math.sin(gTime * 0.15) * 7;

      //upper and lower pectoral fins
      ctx.fillStyle = '#091a10';
      ctx.beginPath();
      ctx.moveTo(-13, -6 - kick * 0.5);
      ctx.bezierCurveTo(-22, -11 - kick * 0.5, -36, -17 - kick * 0.5, -31, -10 - kick * 0.5);
      ctx.bezierCurveTo(-27, -5 - kick * 0.5, -19, -5 - kick * 0.5, -13, -6 - kick * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-13, 6 + kick * 0.5);
      ctx.bezierCurveTo(-22, 11 + kick * 0.5, -36, 17 + kick * 0.5, -31, 10 + kick * 0.5);
      ctx.bezierCurveTo(-27, 5 + kick * 0.5, -19, 5 + kick * 0.5, -13, 6 + kick * 0.5);
      ctx.closePath();
      ctx.fill();

      //fin panels
      ctx.fillStyle = '#162030';
      ctx.beginPath();
      ctx.ellipse(-12, -5 - kick * 0.32, 10, 4, 0.12, 0, 6.28);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(-12, 5 + kick * 0.32, 10, 4, -0.12, 0, 6.28);
      ctx.fill();

      //tail
      ctx.fillStyle = '#1c3228';
      ctx.beginPath();
      ctx.rect(-18, 9, 15, 7);
      ctx.fill();
      ctx.fillStyle = '#2a4e3c';
      ctx.beginPath();
      ctx.rect(-17, 10, 13, 5);
      ctx.fill();

      //indicator lights on the tail
      ctx.fillStyle = 'rgba(0,210,120,0.8)';
      ctx.fillRect(-8, 10, 3, 2);
      ctx.fillStyle = `rgba(0,255,140,${0.5 + 0.5 * Math.sin(gTime * 0.11)})`; //blinks
      ctx.beginPath();
      ctx.arc(-13.5, 10, 1.5, 0, 6.28);
      ctx.fill();

      //propeller shaft
      ctx.strokeStyle = 'rgba(0,150,100,0.55)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-7, 11);
      ctx.bezierCurveTo(-1, 15, 5, 13, 10, 10);
      ctx.stroke();

      //hull
      ctx.fillStyle = '#0c1b28';
      ctx.beginPath();
      ctx.ellipse(0, 0, 17, 11, 0, 0, 6.28);
      ctx.fill();

      //internal ribbing lines
      ctx.strokeStyle = 'rgba(0,160,240,0.22)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-13, 5);
      ctx.lineTo(9, 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-13, -5);
      ctx.lineTo(9, -5);
      ctx.stroke();

      //instrument panel
      ctx.fillStyle = 'rgba(0,200,140,0.1)';
      ctx.strokeStyle = 'rgba(0,200,140,0.4)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.rect(-4, -5, 10, 8);
      ctx.fill();
      ctx.stroke();

      //three status dots inside the panel
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i === 2 ? `rgba(0,255,140,${0.4 + 0.6 * Math.sin(gTime * 0.13 + i * 1.2)})` : '#00bb80';
        ctx.beginPath();
        ctx.arc(-2 + i * 3.5, -2.5, 1, 0, 6.28);
        ctx.fill();
      }
      //auxiliary light inside the panel
      ctx.fillStyle = `rgba(0,220,255,${0.35 + 0.35 * Math.sin(gTime * 0.09)})`;
      ctx.beginPath();
      ctx.arc(3, 2.5, 1.5, 0, 6.28);
      ctx.fill();

      //top sensor
      ctx.fillStyle = '#182a3a';
      ctx.beginPath();
      ctx.ellipse(-2, -10, 7, 3.5, -0.15, 0, 6.28);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,160,255,0.25)';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      //rear fins
      ctx.fillStyle = '#1a2e40';
      ctx.beginPath();
      ctx.ellipse(7, 8, 6, 4, 0.42, 0, 6.28);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(18, 9, 8, 3.5, 0.18, 0, 6.28);
      ctx.fill();

      //gun barrel
      ctx.fillStyle = '#0b1520';
      ctx.beginPath();
      ctx.rect(13, 6, 19, 5);
      ctx.fill();

      //sight indicator strips
      ctx.fillStyle = 'rgba(0,140,255,0.55)';
      ctx.fillRect(15, 7, 5, 2);
      ctx.fillStyle = 'rgba(0,200,140,0.45)';
      ctx.fillRect(22, 7, 3, 2);
      ctx.fillStyle = '#070f18';
      ctx.fillRect(29, 7, 10, 2.5);

      //detail box on top
      ctx.fillStyle = '#16263a';
      ctx.beginPath();
      ctx.rect(17, 4, 6, 3);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,200,255,0.3)';
      ctx.fillRect(18, 4, 4, 1);

      //muzzle glow
      const muzzleGlow = ctx.createRadialGradient(39, 8.2, 0, 39, 8.2, 9);
      muzzleGlow.addColorStop(0, 'rgba(0,210,255,0.5)');
      muzzleGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = muzzleGlow;
      ctx.beginPath();
      ctx.arc(39, 8.2, 9, 0, 6.28);
      ctx.fill();

      //cockpit
      ctx.fillStyle = '#0d1c2c';
      ctx.beginPath();
      ctx.arc(18, 0, 11, 0, 6.28);
      ctx.fill();

      //top hood
      ctx.fillStyle = '#182838';
      ctx.beginPath();
      ctx.ellipse(15, -8, 6, 4, -0.3, 0, Math.PI);
      ctx.fill();

      //inner arc
      ctx.strokeStyle = 'rgba(0,160,220,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(18, 0, 11, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();

      //visor lens
      ctx.fillStyle = 'rgba(0,185,230,0.16)';
      ctx.beginPath();
      ctx.ellipse(21, -1, 7.5, 6, 0, 0, 6.28);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,220,255,0.72)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const visorGrad = ctx.createRadialGradient(23, -2, 1, 22, -1, 7);
      visorGrad.addColorStop(0, 'rgba(0,220,255,0.52)');
      visorGrad.addColorStop(1, 'rgba(0,90,160,0.04)');
      ctx.fillStyle = visorGrad;
      ctx.beginPath();
      ctx.ellipse(21, -1, 6.5, 5, 0, 0, 6.28);
      ctx.fill();

      //horizontal scan lines inside the visor
      ctx.strokeStyle = 'rgba(0,255,200,0.17)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(14, -3.5);
      ctx.lineTo(27, -3.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(14, 0.5);
      ctx.lineTo(27, 0.5);
      ctx.stroke();

      //red alert dot
      ctx.fillStyle = `rgba(255,80,80,${0.5 + 0.5 * Math.sin(gTime * 0.2)})`;
      ctx.beginPath();
      ctx.arc(22, -1, 1.2, 0, 6.28);
      ctx.fill();

      //navigation beacon
      ctx.fillStyle = `rgba(0,255,190,${0.55 + 0.45 * Math.sin(gTime * 0.08)})`;
      ctx.beginPath();
      ctx.arc(10, -8, 2.2, 0, 6.28);
      ctx.fill();

      const beaconGlow = ctx.createRadialGradient(10, -8, 0, 10, -8, 6);
      beaconGlow.addColorStop(0, 'rgba(0,255,190,0.3)');
      beaconGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = beaconGlow;
      ctx.beginPath();
      ctx.arc(10, -8, 6, 0, 6.28);
      ctx.fill();

      //bottom shadow arc on the cockpit glass
      ctx.strokeStyle = '#09131e';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(18, 0, 11, Math.PI * 0.22, Math.PI * 0.78);
      ctx.stroke();

      ctx.restore();
      R.HealthBar(x, y - 36, 50, this.health, this.maxHealth);
    }
  }

  //all enemy types extend this class
  class Enemy {
    constructor(x, y, type, radius, health, color, canShoot, shootInterval) {
      this.x = x;
      this.y = y;
      this.type = type;
      this.radius = radius;
      this.health = health;
      this.maxHealth = health;
      this.color = color;
      this.canShoot = canShoot || false;
      this.shootInterval = shootInterval || 999;

      //randomize the initial shoot timer so enemies don't all fire in sync
      this.shootTimer = ~~(Math.random() * (shootInterval || 999));
      this.velX = (Math.random() - 0.5) * 0.8;  //small random initial drift
      this.velY = (Math.random() - 0.5) * 0.8;
      this.phase = Math.random() * 6.28;        //randomize wobble start phase
      this.flashFrames = 0;
      this.active = true;
      this.facing = 0;    //radians used by subclass Draw()
      this.baseSpeed = 1;
      this.wobbleX = 0.2; //horizontal wobble amplitude
      this.wobbleY = 0.2; //vertical wobble amplitude
    }

    //overridden by subclass
    get ContactDamage() {
      return 8;
    }

    TakeDamage(damage) {
      this.health -= damage;
      this.flashFrames = 6; //triggers white flash
      return this.health <= 0 ? 'dead' : null;
    }

    //subclasses override this to return Bullet instances
    CreateShot(player) {
      return [];
    }

    Update(player, waveNum) {
      this.phase += 0.04;
      if (this.flashFrames > 0)
        this.flashFrames--;

      const speed = this.baseSpeed * (1 + waveNum * 0.06);
      const dirX = player.x - this.x;
      const dirY = player.y - this.y;
      const distance = Math.sqrt(dirX * dirX + dirY * dirY) || 1; //avoid div by 0

      //store facing angle for subclasses that rotate their sprite toward the player
      this.facing = Math.atan2(dirY, dirX);

      //exponential average steering toward the player
      this.velX = this.velX * 0.9 + (dirX / distance) * speed * 0.16;
      this.velY = this.velY * 0.9 + (dirY / distance) * speed * 0.16;

      //clamp velocity components to prevent runaway
      this.velX = Math.max(-speed, Math.min(speed, this.velX));
      this.velY = Math.max(-speed, Math.min(speed, this.velY));

      //apply velocity + independent sine-wave wobble on each axis
      //different phase multipliers (0.7, 0.5) make the path look organic
      this.x += this.velX + Math.sin(this.phase * 0.7) * this.wobbleX;
      this.y += this.velY + Math.cos(this.phase * 0.5) * this.wobbleY;

      //shooting logic
      if (this.canShoot) {
        this.shootTimer++;
        if (this.shootTimer >= this.shootInterval) {
          this.shootTimer = 0;
          return this.CreateShot(player); //returns array of bullet instances
        }
      }
      return null;
    }

    //circle–circle check
    //uses a 6px tolerance
    Touching(player) {
      return (player.x - this.x) ** 2 + (player.y - this.y) ** 2 < (player.radius + this.radius - 6) ** 2;
    }

    //55% chance to drop a random powerup at the death position
    TryDrop() {
      return Math.random() > 0.45 ? null : new Powerup(this.x, this.y, Math.random() < 0.5 ? 'shield' : 'multi');
    }

    //each subclass overrides
    Draw() {
    }
  }

  //Jellyfish
  //the weakest, slowest enemy and no shooting
  //petalCount (5–6) bezier-curve "petals" around a central bell
  //9 nematocyst nodes orbiting the bell edge
  //6 tentacles each made of 4 chain-linked segments offset by perpendicular sine waves to simulate fluid tentacle motion
  //small eyes with iris highlights drawn with layered ellipses
  //petal geometry uses quadratic/cubic bezier curves
  //each petal goes from the center to tip at angle "pa"
  class Jellyfish extends Enemy {
    constructor(x, y, waveNum) {
      //health scales with wave number so later waves are tougher
      super(x, y, 'jellyfish', 22, 30 * (1 + waveNum * 0.2), null, false);
      this.baseSpeed = 0.55;
      this.wobbleX = 0.9;  //wide horizontal wobble for a floaty feel
      this.wobbleY = 0.6;
      this.petalCount = 5 + ~~(Math.random() * 2);  //5 or 6 petals
      this.petalHue = 260 + ~~(Math.random() * 80); //purple–pink range

      //rach tentacle has an independent swing phase and random length
      this.tentacles = Array.from({length: 6}, (_, i) => ({
        phase: i * 1.05,               //evenly spaced phase start
        length: 22 + Math.random() * 12
      }));
    }

    get ContactDamage() {
      return 8;
    }

    Draw() {
      let i;
      const {x, y, radius, phase, flashFrames, petalCount, petalHue, tentacles} = this;
      ctx.save();
      ctx.translate(x, y);

      const breathe = 1 + 0.09 * Math.sin(phase * 1.7); //breathing scale factor
      const hue = petalHue;
      var isFlashing = flashFrames > 0;

      //ambient glow around the whole body
      const ag = ctx.createRadialGradient(0, 0, radius * 0.4, 0, 0, radius * 2.2);
      ag.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.18)' : `hsla(${hue},100%,55%,0.14)`);
      ag.addColorStop(1, 'transparent');
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 2.2, 0, 6.28);
      ctx.fill();

      for (i = 0; i < petalCount; i++) {
        //compute this petal angle and its neighbors
        const pa = i / petalCount * 6.28 + phase * 0.2;           //this petal
        const na = ((i + 1) / petalCount) * 6.28 + phase * 0.2;   //next petal
        const pa0 = ((i - 1 + petalCount) / petalCount) * 6.28 + phase * 0.2; //prev petal

        const tipX = Math.cos(pa) * radius * breathe;
        const tipY = Math.sin(pa) * radius * breathe;

        //cubic bezier: center -> tip with control points at adjacent angles to make the petal swell and taper
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(
          Math.cos(pa0) * radius * 0.55 * breathe,
          Math.sin(pa0) * radius * 0.55 * breathe,
          tipX * 1.05, tipY * 1.05,
          tipX, tipY
        );
        ctx.bezierCurveTo(
          Math.cos(na) * radius * 0.55 * breathe,
          Math.sin(na) * radius * 0.55 * breathe,
          Math.cos(na) * radius * 0.18,
          Math.sin(na) * radius * 0.18,
          0, 0
        );

        //radial fill centered near the petal tip for translucent color
        const pg = ctx.createRadialGradient(tipX * 0.38, tipY * 0.38, 0, tipX * 0.35, tipY * 0.35, radius * 0.9);
        if (isFlashing) {
          pg.addColorStop(0, 'rgba(255,255,255,0.9)');
          pg.addColorStop(1, 'rgba(200,180,255,0.25)');
        } else {
          pg.addColorStop(0, `hsla(${hue + i * 8},95%,60%,0.75)`);
          pg.addColorStop(0.55, `hsla(${hue + 20},80%,35%,0.5)`);
          pg.addColorStop(1, 'transparent');
        }
        ctx.fillStyle = pg;
        ctx.fill();

        //vein line from center to tip
        ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.4)' : `hsla(${hue + 180},80%,75%,${0.18 + 0.12 * Math.sin(phase + i)})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(
          tipX * 0.28 + Math.cos(pa + 1.57) * 5,
          tipY * 0.28 + Math.sin(pa + 1.57) * 5,
          tipX * 0.82, tipY * 0.82
        );
        ctx.stroke();
      }

      //9 glowing nodes around the bell edge
      for (i = 0; i < 9; i++) {
        const na2 = i / 9 * 6.28 + phase * 0.55;
        const nr = radius * (breathe - 0.04);
        const nAlpha = 0.45 + 0.45 * Math.sin(phase * 2.2 + i * 0.7); //per-node flicker
        const nx = Math.cos(na2) * nr;
        const ny = Math.sin(na2) * nr;

        //glow around each node
        const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, 7);
        ng.addColorStop(0, isFlashing ? `rgba(255,255,255,${nAlpha})` : `hsla(${hue + i * 20},100%,75%,${nAlpha})`);
        ng.addColorStop(1, 'transparent');
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(nx, ny, 7, 0, 6.28);
        ctx.fill();

        //solid dot core
        ctx.fillStyle = isFlashing ? '#fff' : `hsla(${hue + i * 20},100%,85%,0.85)`;
        ctx.beginPath();
        ctx.arc(nx, ny, 2.2, 0, 6.28);
        ctx.fill();
      }

      //central bell core
      const cp = 0.65 + 0.35 * Math.sin(phase * 2.6);
      const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.4);
      cg.addColorStop(0, isFlashing ? `rgba(255,255,255,${cp})` : `hsla(${hue + 40},100%,75%,${cp})`);
      cg.addColorStop(0.5, isFlashing ? 'rgba(200,180,255,0.4)' : `hsla(${hue},90%,40%,0.45)`);
      cg.addColorStop(1, 'transparent');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.4, 0, 6.28);
      ctx.fill();

      //3 eyes
      [
        {ex: -radius * 0.14, ey: -radius * 0.1, eyeColor: isFlashing ? '#fff' : `hsl(${hue + 180},100%,70%)`},
        {ex: radius * 0.14, ey: -radius * 0.1, eyeColor: isFlashing ? '#fff' : `hsl(${hue + 200},100%,65%)`},
        {ex: 0, ey: radius * 0.12, eyeColor: isFlashing ? '#fff' : `hsl(${hue + 160},100%,75%)`}
      ].forEach(({ex, ey, eyeColor}) => {

        //black
        ctx.fillStyle = '#0a0015';
        ctx.beginPath();
        ctx.ellipse(ex, ey, radius * 0.12, radius * 0.1, 0, 0, 6.28);
        ctx.fill();

        //iris
        ctx.fillStyle = eyeColor;
        ctx.beginPath();
        ctx.ellipse(ex, ey, radius * 0.08, radius * 0.07, 0, 0, 6.28);
        ctx.fill();

        //pupil
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(ex, ey, radius * 0.042, radius * 0.052, 0, 0, 6.28);
        ctx.fill();

        //small bright dot offset from center
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.beginPath();
        ctx.arc(ex - radius * 0.028, ey - radius * 0.026, radius * 0.018, 0, 6.28);
        ctx.fill();

        //iris glow
        const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, radius * 0.2);
        eg.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.3)' : eyeColor.replace('hsl', 'hsla').replace(')', ',0.28)'));
        eg.addColorStop(1, 'transparent');
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(ex, ey, radius * 0.2, 0, 6.28);
        ctx.fill();
      });

      //tentacles
      tentacles.forEach((tentacle, i) => {
        let s;
        const baseAngle = i / tentacles.length * 6.28;
        //start point at the bell edge
        const points = [{x: Math.cos(baseAngle) * radius * 0.78, y: Math.sin(baseAngle) * radius * 0.78}];

        //build chain of 4 segments each offset perpendicular to the base direction
        for (s = 0; s < 4; s++) {
          const segPhase = phase * 1.5 + tentacle.phase + s * 1.2;
          //perpendicular direction = rotate baseAngle by PI/2 (add 1.57).
          const offsetX = Math.cos(baseAngle + 1.57) * Math.sin(segPhase) * 9;
          const offsetY = Math.sin(baseAngle + 1.57) * Math.sin(segPhase) * 9;
          points.push({
            x: points[s].x + Math.cos(baseAngle) * tentacle.length * 0.27 + offsetX,
            y: points[s].y + Math.sin(baseAngle) * tentacle.length * 0.27 + offsetY
          });
        }

        //ade opacity and taper lineWidth toward the tip
        for (s = 0; s < points.length - 1; s++) {
          const fadeAlpha = 1 - s * 0.2;
          ctx.strokeStyle = isFlashing
            ? `rgba(255,255,255,${fadeAlpha * 0.65})`
            : `hsla(${hue - s * 22 + i * 8},88%,68%,${fadeAlpha * 0.6})`;
          ctx.lineWidth = 2.8 - s * 0.5;
          ctx.shadowColor = isFlashing ? '#fff' : `hsl(${hue + i * 10},100%,75%)`;
          ctx.shadowBlur = 5;
          ctx.beginPath();
          ctx.moveTo(points[s].x, points[s].y);
          ctx.lineTo(points[s + 1].x, points[s + 1].y);
          ctx.stroke();

          //joint glow dot at each knuckle
          if (s > 0) {
            const jg = ctx.createRadialGradient(points[s].x, points[s].y, 0, points[s].x, points[s].y, 4.5);
            jg.addColorStop(0, isFlashing
              ? `rgba(255,255,255,${0.55 + 0.4 * Math.sin(phase + s)})`
              : `hsla(${hue + s * 55 + 180},100%,80%,${0.55 + 0.4 * Math.sin(phase + s)})`);
            jg.addColorStop(1, 'transparent');
            ctx.fillStyle = jg;
            ctx.beginPath();
            ctx.arc(points[s].x, points[s].y, 4.5, 0, 6.28);
            ctx.fill();
          }
        }
        ctx.shadowBlur = 0;
      });

      ctx.restore();
      R.HealthBar(x, y - radius - 18, radius * 2.5, this.health, this.maxHealth);
    }
  }

  //medium enemy with a rotating hexagonal body and optional triple-shot
  //crystalRotation accumulates each frame so the outer spike rings spin continuously
  //the inner ring rotates counter-clockwise
  //shot pattern: 3 bullets spread at -0.28, 0, +0.28 rad from aim angle
  //the compound eye is an ellipse filled with a grid of hex cells
  class Puffer extends Enemy {
    constructor(x, y, waveNum, canShoot) {
      super(x, y, 'puffer', 28, 60 * (1 + waveNum * 0.2), null, canShoot, 180);
      this.baseSpeed = 0.65;
      this.wobbleX = 0.15;
      this.wobbleY = 0.15;
      this.crystalRotation = Math.random() * 6.28; //random start angle for spikes
    }

    get ContactDamage() {
      return 12;
    }

    //triple shot at the player
    CreateShot(player) {
      const angle = Math.atan2(player.y - this.y, player.x - this.x);
      return [-0.28, 0, 0.28].map(offset =>
        new Bullet(this.x, this.y,
          Math.cos(angle + offset) * 4.2,
          Math.sin(angle + offset) * 4.2,
          8, 95, 5, '#ff8020', 'enemy')
      );
    }

    Draw() {
      let i;
      const {x, y, radius, phase, flashFrames, canShoot, shootTimer, shootInterval} = this;
      const isFlashing = flashFrames > 0;

      //crystalRotation accumulates independently of the phase oscillator so
      //the spike animation is always advancing regardless of other state
      this.crystalRotation += 0.018;
      const rotation = this.crystalRotation;

      ctx.save();
      ctx.translate(x, y);

      //ambient glow
      const ag = ctx.createRadialGradient(0, radius * 0.2, 0, 0, 0, radius * 1.7);
      ag.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.15)' : `rgba(255,130,0,${0.12 + 0.06 * Math.sin(phase)})`);
      ag.addColorStop(1, 'transparent');
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.7, 0, 6.28);
      ctx.fill();

      //pre-fire warning ring appears when 62% of the shoot interval has elapsed
      if (canShoot && shootTimer > shootInterval * 0.62) {
        ctx.save();
        ctx.globalAlpha = 0.22 + 0.18 * Math.sin(gTime * 0.38);
        ctx.strokeStyle = '#ff8020';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(0, 0, radius + 24, 0, 6.28);
        ctx.stroke();
        ctx.restore();
      }

      //6 outer spike
      for (i = 0; i < 6; i++) {
        const ba = i / 6 * 6.28 + rotation;
        ctx.save();
        ctx.rotate(ba);
        //spike length oscillates with sin
        const blen = radius * 0.6 + 5 * Math.sin(phase * 2.1 + i);
        ctx.beginPath();
        ctx.moveTo(0, radius * 0.82);
        ctx.lineTo(blen, radius * 0.88);
        ctx.lineTo(blen + 5, radius * 0.96);
        ctx.lineTo(blen, radius * 1.04);
        ctx.lineTo(0, radius * 0.95);
        ctx.closePath();
        const og = ctx.createLinearGradient(0, radius * 0.82, blen, radius * 0.96);
        if (isFlashing) {
          og.addColorStop(0, 'rgba(255,255,255,0.95)');
          og.addColorStop(1, 'rgba(255,220,150,0.4)');
        } else {
          og.addColorStop(0, 'rgba(255,170,10,0.9)');
          og.addColorStop(1, 'rgba(200,60,0,0.2)');
        }
        ctx.fillStyle = og;
        ctx.fill();
        ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.5)' : 'rgba(255,200,60,0.45)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.restore();
      }

      //inner crystal ring
      for (i = 0; i < 4; i++) {
        const iba = i / 4 * 6.28 - rotation * 1.4;
        ctx.save();
        ctx.rotate(iba);
        ctx.beginPath();
        ctx.moveTo(0, radius * 0.5);
        ctx.lineTo(radius * 0.68, radius * 0.56);
        ctx.lineTo(radius * 0.76, radius * 0.62);
        ctx.lineTo(radius * 0.68, radius * 0.69);
        ctx.lineTo(0, radius * 0.64);
        ctx.closePath();
        const ig = ctx.createLinearGradient(0, radius * 0.5, radius * 0.7, radius * 0.62);
        if (isFlashing) {
          ig.addColorStop(0, 'rgba(255,255,220,0.95)');
          ig.addColorStop(1, 'rgba(255,255,255,0.2)');
        } else {
          ig.addColorStop(0, 'rgba(0,200,255,0.85)');
          ig.addColorStop(1, 'rgba(0,60,200,0.15)');
        }
        ctx.fillStyle = ig;
        ctx.fill();
        ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.4)' : 'rgba(60,220,255,0.45)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
        ctx.restore();
      }

      //hexagon hull
      HexPath(0, 0, radius, 6);
      const hullGrad = ctx.createRadialGradient(-radius * 0.25, -radius * 0.28, radius * 0.08, 0, 0, radius);
      if (isFlashing) {
        hullGrad.addColorStop(0, '#fff');
        hullGrad.addColorStop(1, 'rgba(255,180,80,0.85)');
      } else {
        hullGrad.addColorStop(0, '#2d1800');
        hullGrad.addColorStop(0.5, '#170d00');
        hullGrad.addColorStop(1, '#0a0600');
      }
      ctx.fillStyle = hullGrad;
      ctx.fill();

      //lines from center to each vertex for a segmented look
      ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.45)' : `rgba(255,120,0,${0.35 + 0.15 * Math.sin(phase)})`;
      ctx.lineWidth = 1.1;
      for (i = 0; i < 6; i++) {
        const sa = i / 6 * 6.28 + 0.524; //same offset as HexPath
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(sa) * radius, Math.sin(sa) * radius);
        ctx.stroke();
      }

      //hex outline
      HexPath(0, 0, radius, 6);
      ctx.strokeStyle = isFlashing
        ? 'rgba(255,255,255,0.8)'
        : `rgba(255,140,0,${0.5 + 0.28 * Math.sin(phase)})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      //3 bioluminescent lobe spots on the hull
      for (i = 0; i < 3; i++) {
        const lp = 0.38 + 0.3 * Math.sin(phase * 1.6 + i * 2.09); //flicker
        const lx = Math.cos(i / 3 * 6.28) * radius * 0.3;
        const ly = radius * 0.08 + Math.sin(i / 3 * 6.28) * radius * 0.18;
        ctx.fillStyle = isFlashing
          ? `rgba(255,255,200,${lp})`
          : `rgba(255,110,0,${lp})`;
        ctx.beginPath();
        ctx.ellipse(lx, ly, radius * 0.13, radius * 0.09, i * 1.05, 0, 6.28);
        ctx.fill();
      }

      //eye
      const er = radius * 0.33;
      const eyeCY = -radius * 0.25;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(0, eyeCY, er + 2.5, er * 0.88 + 2, 0, 0, 6.28);
      ctx.fill();

      //hex cell grid inside the eye (each cell flickers independently)
      const cellRadius = er * 0.3;
      const cellOffsets = [
        {ox: 0, oy: 0},
        {ox: -cellRadius * 0.95, oy: cellRadius * 0.55},
        {ox: cellRadius * 0.95, oy: cellRadius * 0.55},
        {ox: -cellRadius * 0.95, oy: -cellRadius * 0.55},
        {ox: cellRadius * 0.95, oy: -cellRadius * 0.55},
        {ox: 0, oy: -cellRadius * 1.12},
        {ox: 0, oy: cellRadius * 1.12}
      ];

      cellOffsets.forEach(({ox, oy}, ci) => {
        //only draw cells that fall inside the elliptical eye boundary
        //uses the implicit ellipse equation: x^2/a^2 + y^2/b^2 < 1
        if (ox * ox / (er * er) + oy * oy / ((er * 0.88) ** 2) < 0.82) {
          const cAlpha = isFlashing ? 1 : 0.65 + 0.35 * Math.abs(Math.sin(phase * 1.3 + ci * 0.6));
          ctx.fillStyle = isFlashing
            ? `rgba(255,255,255,${cAlpha})`
            : `hsla(${30 + ci * 10},100%,55%,${cAlpha})`;
          HexPath(ox, eyeCY + oy, cellRadius * 0.46, 6);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 0.55;
          ctx.stroke();
        }
      });

      //eye glow
      const eyeGlow = ctx.createRadialGradient(0, eyeCY, 0, 0, eyeCY, er * 1.5);
      eyeGlow.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.4)' : 'rgba(255,140,0,0.38)');
      eyeGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = eyeGlow;
      ctx.beginPath();
      ctx.arc(0, eyeCY, er * 1.5, 0, 6.28);
      ctx.fill();

      //spines
      for (i = 0; i < 8; i++) {
        const spa = i / 8 * 6.28 + 0.39;
        //distance oscillate radius + 7 + 7*sin(...)
        const ext = radius + 7 + 7 * Math.sin(phase * 1.9 + i * 0.78);
        const sx = Math.cos(spa), sy = Math.sin(spa);
        ctx.strokeStyle = isFlashing ? '#fff' : `rgba(255,150,20,${0.7 + 0.3 * Math.sin(phase + i)})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sx * radius * 0.96, sy * radius * 0.96);
        ctx.lineTo(sx * ext, sy * ext);
        ctx.stroke();

        //glowing tip dot
        const tg = ctx.createRadialGradient(sx * ext, sy * ext, 0, sx * ext, sy * ext, 3.5);
        tg.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.9)' : 'rgba(0,200,255,0.9)');
        tg.addColorStop(1, 'transparent');
        ctx.fillStyle = tg;
        ctx.beginPath();
        ctx.arc(sx * ext, sy * ext, 3.5, 0, 6.28);
        ctx.fill();
      }

      ctx.restore();
      R.HealthBar(x, y - radius * 1.18 - 16, radius * 2.6, this.health, this.maxHealth);
    }
  }


  //the toughest regular enemy has a bioluminescent lure that pulses and fires a single high-damage bolt
  //the body is built from 5 overlapping ellipses that taper toward the tail
  //a slight wobble (sin(phase * 1.15 + segIndex * 0.85)) makes non-head segments undulate independently
  //the jaw open amount (jawOpenAmount) uses the same sin-wave as the body animation and is only positive
  //during the upswing so the mouth snaps open and shut rhythmically
  //the lure rod is a quadratic bezier from the dorsal fin base to the lure position
  class Anglerfish extends Enemy {
    constructor(x, y, waveNum, canShoot) {
      super(x, y, 'anglerfish', 34, 100 * (1 + waveNum * 0.2), null, canShoot, 230);
      this.baseSpeed = 0.45;
      this.wobbleX = 0.15;
      this.wobbleY = 0.15;
      this.lure = {phase: 0}; //independent oscillator for the lure glow
    }

    get ContactDamage() {
      return 18;
    }

    Update(player, waveNum) {
      this.lure.phase += 0.07; //advance lure glow independently of body phase
      return super.Update(player, waveNum);
    }

    //single fast high-damage bolt aimed directly at the player
    CreateShot(player) {
      const angle = Math.atan2(player.y - this.y, player.x - this.x);
      return [new Bullet(this.x, this.y,
        Math.cos(angle) * 7, Math.sin(angle) * 7,
        15, 100, 7, '#40ffa0', 'enemy')];
    }

    Draw() {
      let ti;
      const {x, y, radius, phase, flashFrames, lure, canShoot, shootTimer, shootInterval, facing} = this;
      const isFlashing = flashFrames > 0;

      //jaw opens only when sin is positive
      const jawOpenAmount = Math.max(0, Math.sin(phase * 1.3)) * 0.38;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(facing); //entire fish rotates toward the player

      //ambient glow
      const ag = ctx.createRadialGradient(0, 0, radius * 0.4, 0, 0, radius * 2);
      ag.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.16)' : 'rgba(0,190,80,0.13)');
      ag.addColorStop(1, 'transparent');
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 2, 0, 6.28);
      ctx.fill();

      //pre-fire warning glow above the lure position when ready to shoot
      if (canShoot && shootTimer > shootInterval * 0.6) {
        const lx = radius * 1.15, ly = -radius * 1.35;
        const la = 0.4 + 0.4 * Math.sin(phase * 2.8);
        const wg = ctx.createRadialGradient(lx, ly, 0, lx, ly, radius * 0.85);
        wg.addColorStop(0, `rgba(0,255,140,${la * 0.55})`);
        wg.addColorStop(1, 'transparent');
        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.arc(lx, ly, radius * 0.85, 0, 6.28);
        ctx.fill();
      }

      //5 ellipses body segments drawn back-to-front so the head is on top
      const segs = [
        {ox: 0, oy: 0, rx: radius, ry: radius * 0.82},
        {ox: -radius * 1.08, oy: 0, rx: radius * 0.7, ry: radius * 0.59},
        {ox: -radius * 1.82, oy: 0, rx: radius * 0.52, ry: radius * 0.43},
        {ox: -radius * 2.40, oy: 0, rx: radius * 0.37, ry: radius * 0.3},
        {ox: -radius * 2.85, oy: 0, rx: radius * 0.25, ry: radius * 0.2}
      ];

      //draw from tail (index 4) to head (index 0) so head overlaps tail
      for (let si = segs.length - 1; si >= 0; si--) {
        const seg = segs[si];
        //non-head segments undulate
        const wob = si === 0 ? 0 : Math.sin(phase * 1.15 + si * 0.85) * 2.5;
        const segY = seg.oy + wob;
        //radial gradient darken toward the tail
        const sg2 = ctx.createRadialGradient(
          seg.ox - seg.rx * 0.22, segY - seg.ry * 0.3, seg.rx * 0.05,
          seg.ox, segY, seg.rx
        );
        const dk = si / segs.length; //darkening factor 0=head 1=tail
        if (isFlashing) {
          sg2.addColorStop(0, '#fff');
          sg2.addColorStop(1, 'rgba(120,255,160,0.6)');
        } else {
          sg2.addColorStop(0, `rgba(${15 + dk * 18},${80 - dk * 28},${42 - dk * 18},0.97)`);
          sg2.addColorStop(0.6, `rgba(${8 + dk * 8},${48 - dk * 18},${22 - dk * 8},0.92)`);
          sg2.addColorStop(1, 'rgba(4,18,10,0.88)');
        }
        ctx.fillStyle = sg2;
        ctx.beginPath();
        ctx.ellipse(seg.ox, segY, seg.rx, seg.ry, 0, 0, 6.28);
        ctx.fill();
        //horizontal scale markings across each segment
        ctx.strokeStyle = isFlashing
          ? 'rgba(255,255,255,0.28)'
          : `rgba(0,150,65,${0.2 + 0.1 * Math.sin(phase + si)})`;
        ctx.lineWidth = 0.9;
        for (let ri = 0; ri < 3; ri++) {
          const rl = (-0.8 + ri * 0.8) * seg.ry * 0.65;
          ctx.beginPath();
          ctx.moveTo(seg.ox - seg.rx * 0.65, segY + rl);
          ctx.lineTo(seg.ox + seg.rx * 0.65, segY + rl);
          ctx.stroke();
        }

        //line where segments overlap
        if (si < segs.length - 1) {
          const ns = segs[si + 1];
          const seamX = (seg.ox + ns.ox) / 2;
          ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.35)' : `rgba(0,${185 - si * 18},${72 - si * 9},${0.28 + 0.18 * Math.sin(phase + si)})`;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(seamX, segY - seg.ry * 0.55);
          ctx.lineTo(seamX, segY + seg.ry * 0.55);
          ctx.stroke();
        }

        //bioluminescent glow on segments
        if (si >= 1 && si <= 3) {
          const ba2 = 0.22 + 0.22 * Math.sin(phase * 1.7 + si * 1.6);
          const bg3 = ctx.createRadialGradient(seg.ox, segY, 0, seg.ox, segY, seg.rx * 0.55);
          bg3.addColorStop(0, isFlashing ? `rgba(200,255,200,${ba2})` : `rgba(0,255,110,${ba2})`);
          bg3.addColorStop(1, 'transparent');
          ctx.fillStyle = bg3;
          ctx.beginPath();
          ctx.ellipse(seg.ox, segY, seg.rx * 0.55, seg.ry * 0.4, 0, 0, 6.28);
          ctx.fill();
        }
      }

      //pectoral fins on segments 1 and 2
      [[segs[1], 1], [segs[2], 2]].forEach(([seg, si2]) => {
        const fw = Math.sin(phase * 1.4 + si2) * radius * 0.24; //fin flap amount
        [-1, 1].forEach(side => {
          ctx.fillStyle = isFlashing ? 'rgba(255,255,255,0.65)' : `rgba(0,${125 - si2 * 14},${52 - si2 * 9},0.52)`;
          ctx.beginPath();
          const bx = seg.ox, by = seg.oy + Math.sin(phase * 1.15 + si2 * 0.85) * 2.5;
          ctx.moveTo(bx, by + side * seg.ry * 0.7);
          ctx.bezierCurveTo(
            bx - radius * 0.18, by + side * (seg.ry * 0.7 + fw * 0.55),
            bx - radius * 0.42, by + side * (seg.ry + fw),
            bx - radius * 0.52, by + side * (seg.ry * 0.9 + fw * 0.85)
          );
          ctx.bezierCurveTo(
            bx - radius * 0.32, by + side * (seg.ry * 0.72 + fw * 0.28),
            bx - radius * 0.12, by + side * (seg.ry * 0.58 + fw * 0.08),
            bx, by + side * seg.ry * 0.52
          );
          ctx.fill();
        });
      });

      //ail fin (last segment)
      const ts = segs[4];
      ctx.fillStyle = isFlashing ? 'rgba(255,255,255,0.65)' : 'rgba(0,115,46,0.58)';
      ctx.beginPath();
      ctx.moveTo(ts.ox, ts.oy);
      ctx.bezierCurveTo(ts.ox - radius * 0.52, ts.oy - radius * 0.38, ts.ox - radius * 0.72, ts.oy - radius * 0.27, ts.ox - radius * 0.68, ts.oy);
      ctx.bezierCurveTo(ts.ox - radius * 0.72, ts.oy + radius * 0.27, ts.ox - radius * 0.52, ts.oy + radius * 0.38, ts.ox, ts.oy);
      ctx.fill();

      //compound hexagonal retina
      [-1, 1].forEach(side => {
        const ex = segs[0].ox + radius * 0.08;
        const ey = segs[0].oy + side * radius * 0.45;
        ctx.fillStyle = '#040d06';
        ctx.beginPath();
        ctx.ellipse(ex, ey, radius * 0.26, radius * 0.2, side * 0.18, 0, 6.28);
        ctx.fill();

        //7 hexagonal photoreceptor cells inside each eye
        [
          {lx: 0, ly: 0},
          {lx: radius * 0.1, ly: 0},
          {lx: -radius * 0.1, ly: 0},
          {lx: radius * 0.055, ly: radius * 0.1},
          {lx: -radius * 0.055, ly: radius * 0.1},
          {lx: radius * 0.055, ly: -radius * 0.1},
          {lx: -radius * 0.055, ly: -radius * 0.1}
        ].forEach(({lx, ly}, li) => {
          const la = isFlashing ? 1 : 0.65 + 0.35 * Math.sin(phase + li * 0.95);
          ctx.fillStyle = isFlashing ? `rgba(255,255,255,${la})` : `hsla(${140 + li * 14},100%,60%,${la})`;
          ctx.beginPath();
          ctx.arc(ex + lx, ey + ly, radius * 0.056, 0, 6.28);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.lineWidth = 0.5;
          ctx.stroke();
        });

        //eye glow
        const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, radius * 0.38);
        eg.addColorStop(0, isFlashing
          ? 'rgba(255,255,255,0.35)'
          : `rgba(0,255,110,${0.18 + 0.14 * Math.sin(phase)})`);
        eg.addColorStop(1, 'transparent');
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(ex, ey, radius * 0.38, 0, 6.28);
        ctx.fill();
      });

      //upper jaw
      const hx = segs[0].ox + radius * 0.72;
      ctx.fillStyle = isFlashing ? 'rgba(255,255,255,0.9)' : '#0a1c0e';
      ctx.beginPath();
      ctx.moveTo(segs[0].ox + radius * 0.28, segs[0].oy - radius * 0.22);
      ctx.bezierCurveTo(hx - radius * 0.08, segs[0].oy - radius * 0.14, hx, segs[0].oy - radius * 0.08, hx, segs[0].oy - radius * 0.03);
      ctx.bezierCurveTo(hx - radius * 0.04, segs[0].oy - radius * 0.03, segs[0].ox + radius * 0.42, segs[0].oy + radius * 0.02, segs[0].ox + radius * 0.28, segs[0].oy - radius * 0.22);
      ctx.fill();

      //upper teeth
      ctx.fillStyle = isFlashing ? '#fff' : 'rgba(195,235,195,0.92)';
      for (ti = 0; ti < 5; ti++) {
        const tx2 = segs[0].ox + radius * 0.36 + ti * radius * 0.08;
        ctx.beginPath();
        ctx.moveTo(tx2, segs[0].oy - radius * 0.07);
        ctx.lineTo(tx2 + radius * 0.03, segs[0].oy - radius * 0.19);
        ctx.lineTo(tx2 + radius * 0.065, segs[0].oy - radius * 0.07);
        ctx.closePath();
        ctx.fill();
      }

      //lower jaw (drops open by jawOpenAmount * radius * 0.3 px)
      const jd = jawOpenAmount * radius * 0.3;
      ctx.fillStyle = isFlashing ? 'rgba(255,255,255,0.9)' : '#0a1c0e';
      ctx.beginPath();
      ctx.moveTo(segs[0].ox + radius * 0.28, segs[0].oy + radius * 0.22 + jd * 0.32);
      ctx.bezierCurveTo(hx - radius * 0.08, segs[0].oy + radius * 0.14 + jd * 0.85, hx, segs[0].oy + radius * 0.08 + jd, hx, segs[0].oy + radius * 0.03 + jd);
      ctx.bezierCurveTo(hx - radius * 0.04, segs[0].oy + radius * 0.04 + jd, segs[0].ox + radius * 0.42, segs[0].oy + jd * 0.2, segs[0].ox + radius * 0.28, segs[0].oy + radius * 0.22 + jd * 0.32);
      ctx.fill();

      //mouth cavity glow when open
      const mg = ctx.createRadialGradient(hx - radius * 0.1, segs[0].oy + jd * 0.5, 0, hx - radius * 0.1, segs[0].oy + jd * 0.5, radius * 0.25);
      mg.addColorStop(0, isFlashing ? 'rgba(255,200,200,0.5)' : 'rgba(0,220,80,0.38)');
      mg.addColorStop(1, 'transparent');
      ctx.fillStyle = mg;
      ctx.beginPath();
      ctx.ellipse(hx - radius * 0.1, segs[0].oy + jd * 0.5, radius * 0.18, radius * 0.12 + jd * 0.3, 0, 0, 6.28);
      ctx.fill();

      //lower teeth
      for (ti = 0; ti < 4; ti++) {
        const ttx = segs[0].ox + radius * 0.38 + ti * radius * 0.08;
        const tty = segs[0].oy + radius * 0.05 + jd * 0.72;
        ctx.fillStyle = isFlashing ? '#fff' : 'rgba(195,235,195,0.92)';
        ctx.beginPath();
        ctx.moveTo(ttx, tty);
        ctx.lineTo(ttx + radius * 0.032, tty + radius * 0.14);
        ctx.lineTo(ttx + radius * 0.065, tty);
        ctx.closePath();
        ctx.fill();
      }

      //pulsing alpha for the lure orb glow
      const la2 = 0.42 + 0.42 * Math.sin(lure.phase * 2.6);
      const lurX = radius * 1.15, lurY = -radius * 1.35;

      //quadratic bezier rod from dorsal fin to lure tip
      ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.6)' : 'rgba(0,170,72,0.65)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(radius * 0.32, -radius * 0.52);
      ctx.quadraticCurveTo(radius * 0.72, -radius, lurX, lurY);
      ctx.stroke();

      //cartilage nodes along the rod
      for (let ci = 0; ci < 3; ci++) {
        const ct = ci / 2;
        const cx2 = radius * 0.32 + (lurX - radius * 0.32) * ct;
        const cy2 = -radius * 0.52 + (lurY + radius * 0.52) * ct;
        ctx.fillStyle = isFlashing ? 'rgba(255,255,255,0.7)' : 'rgba(0,140,58,0.7)';
        ctx.beginPath();
        ctx.ellipse(cx2, cy2, 4.5, 2.8, 0.785, 0, 6.28);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }

      //lure wide glow
      const lurG = ctx.createRadialGradient(lurX, lurY, 0, lurX, lurY, radius * 0.55);
      lurG.addColorStop(0, isFlashing ? `rgba(255,255,255,${la2})` : `rgba(0,255,130,${la2})`);
      lurG.addColorStop(0.45, isFlashing ? 'rgba(200,255,200,0.28)' : 'rgba(0,200,90,0.28)');
      lurG.addColorStop(1, 'transparent');
      ctx.fillStyle = lurG;
      ctx.beginPath();
      ctx.arc(lurX, lurY, radius * 0.55, 0, 6.28);
      ctx.fill();

      //lure tight core
      const orbG = ctx.createRadialGradient(lurX, lurY, 0, lurX, lurY, radius * 0.14);
      orbG.addColorStop(0, isFlashing ? '#fff' : 'rgba(180,255,210,1)');
      orbG.addColorStop(1, isFlashing ? 'rgba(200,255,200,0.4)' : 'rgba(0,210,100,0.55)');
      ctx.fillStyle = orbG;
      ctx.beginPath();
      ctx.arc(lurX, lurY, radius * 0.14, 0, 6.28);
      ctx.fill();

      ctx.restore();
      R.HealthBar(x, y - radius - 22, radius * 2.5, this.health, this.maxHealth);
    }
  }

  //fast boss minion spawned by the Leviathan
  class BabyOctopus extends Enemy {
    constructor(x, y, waveNum) {
      super(x, y, 'baby_octopus', 14, 20 * (1 + waveNum * 0.15), null, false);
      this.baseSpeed = 1.4;
      this.wobbleX = 0;   //sway is handled internally instead
      this.wobbleY = 0;
      this.hue = 22 + ~~(Math.random() * 30);     //warm orange-amber range
      this.arms = Array.from({length: 6}, (_, i) => ({phase: i * 1.047 + Math.random() * 0.5}));
      this.swayFreq = 1.2 + Math.random() * 0.8;  //individual sway speed
      this.swayAmp = 2.2 + Math.random() * 1.4;   //sway magnitude (pixels)
      this.swayOffset = Math.random() * 6.28;     //phase offset for uniqueness
    }

    get ContactDamage() {
      return 6;
    }

    //minions never drop powerups
    TryDrop() {
      return null;
    }

    Update(player, waveNum) {
      this.phase += 0.04;
      if (this.flashFrames > 0)
        this.flashFrames--;

      const speed = this.baseSpeed * (1 + waveNum * 0.06);
      const dirX = player.x - this.x;
      const dirY = player.y - this.y;
      const distance = Math.sqrt(dirX * dirX + dirY * dirY) || 1;

      //perpendicular direction vector (rotated 90° from the approach vector)
      const perpX = -dirY / distance;
      const perpY = dirX / distance;

      //sinusoidal sway perpendicular to the approach direction
      const sway = Math.sin(this.phase * this.swayFreq + this.swayOffset) * this.swayAmp;

      //velocity = forward approach + lateral sway
      const targetVelX = (dirX / distance) * speed * 0.55 + perpX * sway;
      const targetVelY = (dirY / distance) * speed * 0.55 + perpY * sway;

      //exponential smoothing (slower than enemy base = more slippery feel)
      this.velX = this.velX * 0.88 + targetVelX * 0.12;
      this.velY = this.velY * 0.88 + targetVelY * 0.12;
      this.x += this.velX;
      this.y += this.velY;

      //facing follows actual velocity direction (not player angle) so the sprite appears to bank into its sway
      this.facing = Math.atan2(this.velY, this.velX);
      return null;
    }

    Draw() {
      const {x, y, radius, phase, flashFrames, hue, arms, facing} = this;
      const isFlashing = flashFrames > 0;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(facing);

      //ambient glow
      const ag = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius * 2.2);
      ag.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.1)' : `hsla(${hue},100%,55%,0.1)`);
      ag.addColorStop(1, 'transparent');
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 2.2, 0, 6.28);
      ctx.fill();

      //6 arms
      arms.forEach((arm, i) => {
        const baseAngle = (i / 6) * 6.28;
        const wave = Math.sin(phase * 1.3 + arm.phase) * 7; //perpendicular wave amplitude
        const tipDist = radius * 1.9;
        const bx = Math.cos(baseAngle) * radius * 0.5;
        const by = Math.sin(baseAngle) * radius * 0.5;
        const tx = Math.cos(baseAngle) * tipDist;
        const ty = Math.sin(baseAngle) * tipDist;
        const dx = tx - bx, dy = ty - by, len = Math.sqrt(dx * dx + dy * dy) || 1;

        //control point displaced perpendicularly to create the wave bend
        const ctrl = {
          x: (bx + tx) * 0.5 + (-dy / len) * wave,
          y: (by + ty) * 0.5 + (dx / len) * wave
        };

        //shadow stroke (black, thicker) then colored stroke on top
        ctx.strokeStyle = 'rgba(0,0,0,0.42)';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, tx, ty);
        ctx.stroke();
        ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.8)' : `hsla(${hue + i * 8},80%,42%,0.88)`;
        ctx.lineWidth = 4.5;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, tx, ty);
        ctx.stroke();

        //highlight stroke
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, tx, ty);
        ctx.stroke();

        //sucker dots along the arm using the bezier
        for (let t = 0.28; t <= 0.72; t += 0.35) {
          const mt = 1 - t;
          const sx2 = mt * mt * bx + 2 * mt * t * ctrl.x + t * t * tx;
          const sy2 = mt * mt * by + 2 * mt * t * ctrl.y + t * t * ty;
          const sr = 2.5 * (1 - t * 0.4);
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          ctx.beginPath();
          ctx.arc(sx2, sy2, sr, 0, 6.28);
          ctx.fill();
          ctx.fillStyle = isFlashing ? 'rgba(255,220,160,0.3)' : `hsla(${hue + 180},60%,65%,0.22)`;
          ctx.beginPath();
          ctx.arc(sx2, sy2, sr * 0.65, 0, 6.28);
          ctx.fill();
        }
        //glowing tip
        const tg = ctx.createRadialGradient(tx, ty, 0, tx, ty, 5.5);
        tg.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.45)' : `hsla(${hue + 180},100%,72%,0.42)`);
        tg.addColorStop(1, 'transparent');
        ctx.fillStyle = tg;
        ctx.beginPath();
        ctx.arc(tx, ty, 5.5, 0, 6.28);
        ctx.fill();
      });

      //body
      const bodyG = ctx.createRadialGradient(-radius * 0.15, -radius * 0.2, radius * 0.04, 0, 0, radius);
      if (isFlashing) {
        bodyG.addColorStop(0, '#fff');
        bodyG.addColorStop(1, 'rgba(255,180,80,0.85)');
      } else {
        bodyG.addColorStop(0, `hsla(${hue},85%,42%,0.95)`);
        bodyG.addColorStop(0.5, `hsla(${hue + 8},75%,28%,0.92)`);
        bodyG.addColorStop(1, `hsla(${hue + 15},65%,18%,0.88)`);
      }
      ctx.fillStyle = bodyG;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius, radius * 0.9, 0, 0, 6.28);
      ctx.fill();
      ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.5)' : `hsla(${hue},88%,58%,0.3)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius, radius * 0.9, 0, 0, 6.28);
      ctx.stroke();

      //eyes
      [-1, 1].forEach(side => {
        const ex = radius * 0.3, ey = side * radius * 0.3, er2 = radius * 0.22;
        ctx.fillStyle = 'rgba(0,0,0,0.92)';
        ctx.beginPath();
        ctx.arc(ex, ey, er2 + 1, 0, 6.28);
        ctx.fill();

        //iris
        const iris = ctx.createRadialGradient(ex, ey, 0, ex, ey, er2);
        iris.addColorStop(0, isFlashing ? 'rgba(255,255,200,0.95)' : `hsla(${hue + 195},90%,75%,0.92)`);
        iris.addColorStop(1, 'transparent');
        ctx.fillStyle = iris;
        ctx.beginPath();
        ctx.arc(ex, ey, er2, 0, 6.28);
        ctx.fill();

        //pupil
        ctx.fillStyle = 'rgba(0,0,0,0.95)';
        ctx.beginPath();
        ctx.arc(ex, ey, er2 * 0.42, 0, 6.28);
        ctx.fill();

        //specular
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.beginPath();
        ctx.arc(ex - er2 * 0.24, ey - er2 * 0.24, er2 * 0.16, 0, 6.28);
        ctx.fill();

        //eye glow
        const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, er2 * 1.6);
        eg.addColorStop(0, isFlashing ? 'rgba(255,220,100,0.2)' : `hsla(${hue + 200},100%,70%,0.18)`);
        eg.addColorStop(1, 'transparent');
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(ex, ey, er2 * 1.6, 0, 6.28);
        ctx.fill();
      });

      ctx.restore();
      R.HealthBar(x, y - radius - 8, radius * 2.2, this.health, this.maxHealth);
    }
  }

  //massive two-phase octopus creature cycling through four attack states:
  //idle       = default transitions to an attack when attackTimer expires
  //charge     = sprints directly at the player
  //orbit      = circles the player while firing continuously
  //spreadShot = fires a fan of 7 bullets in quick succession
  //minions    = spawns 3 BabyOctopus minions then briefly retreats
  //a random attack is chosen at the end of each idle period
  // weights bias toward "spreadShot" and "orbit" in Phase 2 (when health < 50%) to raise difficulty

  //all three movement modes use the same weighted exponential blend:
  //vel = vel * 0.88 + target * 0.12     (idle / orbit)
  //vel = vel * 0.82 + target * 0.18     (charge — faster response)
  //charge: quick acceleration, feels aggressive
  //orbit:  smooth circular arc, feels deliberate
  //idle:   gently drifts back to a comfortable range

  //orbitAngle accumulates each frame at orbitSpeed radians/frame
  //targetX = player.x + cos(orbitAngle) * orbitRadius
  //targetY = player.y + sin(orbitAngle) * orbitRadius

  //7 bullets are evenly distributed across a 2.2 radian arc centred on the player bearing
  //6x arms are defined in armDefs as (ax,ay) → (tx,ty) vectors (in local  sprite space)
  class Boss {
    constructor(x, y, enemiesRef) {
      this.x = x;
      this.y = y;
      this.radius = 82;             //collision & draw radius
      this.health = 1200;
      this.maxHealth = 1200;
      this.velX = 0;
      this.velY = 0;
      this.phase = 0;               // master body animation oscillator
      this.jawPhase = 0;            //independent jaw open/close oscillator
      this.arms = Array.from({length: 6}, (_, i) => ({
        phase: i * 1.047            // arms start at evenly spaced phases (2π/6)
      }));
      this.attackState = 'idle';
      this.attackTimer = 0;         //counts down to next attack
      this.orbitAngle = 0;          //current angle around the player (orbit mode)
      this.orbitSpeed = 0.012;      //radians per frame for orbit
      this.orbitRadius = 220;       //distance maintained during orbit (px)
      this.slamCooldown = 0;        //prevents repeated melee hits per charge
      this.facingAngle = 0;         //angle (radians) toward player, used for Draw rotation
      this.p2 = false;              //Phase 2 flag (health < 50%)
      this.flashFrames = 0;         //white flash counter after taking damage
      this.enemiesRef = enemiesRef; //live reference to enemies array (for minion spawning)
    }

    get ContactDamage() {
      return 22;
    }

    TakeDamage(damage) {
      this.health -= damage;
      this.flashFrames = 8;    //slightly longer flash than regular enemies
      return this.health <= 0 ? 'dead' : null;
    }

    //runs every frame during the boss phase
    //returns an array of event objects that the Game class processes
    //bullet instances -> pushed to enemyBullets
    //{isMelee, damage} objects -> applied directly as player damage
    Update(player) {
      let i;
      let bspd;
      let angle;
      let tDist;
      let tdx;
      let tdy;
      let targetY;
      let targetX;
      let dist;
      let dy;
      let dx;
      this.phase += 0.04;
      this.jawPhase += 0.06;
      if (this.flashFrames > 0) this.flashFrames--;

      //smooth facing toward player
      const _fDx = player.x - this.x;
      const _fDy = player.y - this.y;
      const _targetAngle = Math.atan2(_fDy, _fDx);
      let _angleDiff = _targetAngle - this.facingAngle;

      while (_angleDiff > Math.PI)
        _angleDiff -= 2 * Math.PI;

      while (_angleDiff < -Math.PI)
        _angleDiff += 2 * Math.PI;
      this.facingAngle += _angleDiff * 0.06;

      if (this.slamCooldown > 0)
        this.slamCooldown--;

      //activate phase 2 when health drops to 50%
      if (!this.p2 && this.health < this.maxHealth * 0.5) {
        this.p2 = true;
        this.orbitSpeed = 0.02;   //orbit faster in Phase 2
        this.orbitRadius = 180;   //close in on the player
      }

      const events = []; //collected bullets + melee events for this frame

      switch (this.attackState) {
        //slowly drift to a comfortable range then wait for the next attack
        case 'idle': {
          dx = player.x - this.x;
          dy = player.y - this.y;
          dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const idleDist = this.p2 ? 220 : 280;
          targetX = player.x - (dx / dist) * idleDist;
          targetY = player.y - (dy / dist) * idleDist;
          tdx = targetX - this.x;
          tdy = targetY - this.y;
          tDist = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
          const idleSpd = this.p2 ? 2.8 : 2.2;
          this.velX = this.velX * 0.88 + (tdx / tDist) * idleSpd * 0.12;
          this.velY = this.velY * 0.88 + (tdy / tDist) * idleSpd * 0.12;
          this.x += this.velX;
          this.y += this.velY;

          this.attackTimer--;
          if (this.attackTimer <= 0) {
            //choose next attack randomly
            const roll = Math.random();
            if (roll < 0.3) {
              this.attackState = 'charge';
              this.attackTimer = this.p2 ? 55 : 75;   //charge duration
            } else if (roll < 0.55) {
              this.attackState = 'orbit';
              this.attackTimer = this.p2 ? 200 : 280;
            } else if (roll < 0.8) {
              this.attackState = 'spreadShot';
              this.attackTimer = this.p2 ? 22 : 30;   //time before spread fires
            } else {
              this.attackState = 'minions';
              this.attackTimer = 120;                 //windup before spawning
            }
          }
          break;
        }

        //sprint straight at the player
        case 'charge': {
          dx = player.x - this.x;
          dy = player.y - this.y;
          dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const spd = this.p2 ? 7.5 : 5.5;

          //0.18 blend weight gives faster angular response than idle (0.12)
          this.velX = this.velX * 0.82 + (dx / dist) * spd * 0.18;
          this.velY = this.velY * 0.82 + (dy / dist) * spd * 0.18;
          this.x += this.velX;
          this.y += this.velY;

          //check melee range (radius + 30px safety margin + player radius)
          const meleeDist = this.radius + player.radius + 30;
          if (dist < meleeDist && this.slamCooldown <= 0) {
            events.push({isMelee: true, damage: this.p2 ? 28 : 22});
            this.slamCooldown = 40; //~0.67s before another slam
          }
          this.attackTimer--;
          if (this.attackTimer <= 0) {
            //idle before next decision
            this.attackState = 'idle';
            this.attackTimer = this.p2 ? 40 : 60;
          }
          break;
        }

        //circle the player at orbitRadius while firing
        case 'orbit': {
          this.orbitAngle += this.orbitSpeed;

          //point on the circle around the player at current orbitAngle
          targetX = player.x + Math.cos(this.orbitAngle) * this.orbitRadius;
          targetY = player.y + Math.sin(this.orbitAngle) * this.orbitRadius;
          tdx = targetX - this.x;
          tdy = targetY - this.y;
          tDist = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
          const ospd = this.p2 ? 3.8 : 2.8;
          this.velX = this.velX * 0.88 + (tdx / tDist) * ospd * 0.12;
          this.velY = this.velY * 0.88 + (tdy / tDist) * ospd * 0.12;
          this.x += this.velX;
          this.y += this.velY;

          //fire a single shot every 45 frames (on phase 2 every 30 frames)
          const fireInterval = this.p2 ? 30 : 45;
          if (this.attackTimer % fireInterval === 0) {
            angle = Math.atan2(player.y - this.y, player.x - this.x);
            bspd = this.p2 ? 5.5 : 4.2;
            events.push(new Bullet(this.x, this.y, Math.cos(angle) * bspd, Math.sin(angle) * bspd, 10, 110, 6, '#ff40a0', 'enemy'));
          }

          this.attackTimer--;
          if (this.attackTimer <= 0) {
            this.attackState = 'idle';
            this.attackTimer = this.p2 ? 30 : 50;
          }
          break;
        }

        //wind-up then fire a fan of 7 bullets
        case 'spreadShot': {
          //slowly drift toward the player during the wind-up
          dx = player.x - this.x;
          dy = player.y - this.y;
          dist = Math.sqrt(dx * dx + dy * dy) || 1;
          this.velX = this.velX * 0.92 + (dx / dist) * 0.8 * 0.08;
          this.velY = this.velY * 0.92 + (dy / dist) * 0.8 * 0.08;
          this.x += this.velX;
          this.y += this.velY;

          this.attackTimer--;
          if (this.attackTimer <= 0) {
            //fire the spread when the timer expires
            const aimAngle = Math.atan2(player.y - this.y, player.x - this.x);
            bspd = this.p2 ? 6.8 : 5.5; //phase 2 bullets are faster

            //distribute 7 bullets evenly across a +-1.1 rad with arc = 2.2 rad
            for (i = 0; i < 7; i++) {
              angle = aimAngle - 1.1 + i * (2.2 / 6);
              events.push(new Bullet(this.x, this.y,
                Math.cos(angle) * bspd, Math.sin(angle) * bspd,
                12, 115, 7, '#ff6060', 'enemy'));
            }
            this.attackState = 'idle';
            this.attackTimer = this.p2 ? 55 : 80;
          }
          break;
        }

        //spawn baby octopus
        case 'minions': {
          dx = player.x - this.x;
          dy = player.y - this.y;
          dist = Math.sqrt(dx * dx + dy * dy) || 1;

          //retreat
          this.velX = this.velX * 0.88 + (-dx / dist) * 2.5 * 0.12;
          this.velY = this.velY * 0.88 + (-dy / dist) * 2.5 * 0.12;
          this.x += this.velX;
          this.y += this.velY;

          this.attackTimer--;
          if (this.attackTimer <= 0) {
            //spawn 3 minions around the boss in a triangle pattern
            for (i = 0; i < 3; i++) {
              const spawnAngle = i / 3 * 6.28; // 0, 2PI/3, 4PI/3
              const spawnDist = this.radius + 60;

              //enemiesRef is the live game enemies array
              this.enemiesRef.push(new BabyOctopus(
                this.x + Math.cos(spawnAngle) * spawnDist,
                this.y + Math.sin(spawnAngle) * spawnDist,
                3  //wave difficulty scaling
              ));
            }
            this.attackState = 'idle';
            this.attackTimer = this.p2 ? 50 : 90;
          }
          break;
        }
      }

      return events;
    }

    //all geometry is in world-space (no ctx.rotate here)
    // the arms are defined with absolute world offsets rather than local-space
    //because the boss body doesn't rotate (only the arm wave animates)
    Draw() {
      let ttx;
      const {x, y, radius, phase, flashFrames, p2, jawPhase, arms} = this;
      const isFlashing = flashFrames > 0;
      const hue = p2 ? 0 : 270;     //phase2 -> red phase11 -> purple

      //jaw open only positive half of sine -> snaps open and stays shut
      //phase 2 multiplier widens the gap by 30%
      const jawAmt = Math.max(0, Math.sin(jawPhase * 1.2)) * (p2 ? 0.52 : 0.4);

      //body pulse
      const pulse = 1 + 0.04 * Math.sin(phase * 1.8);

      ctx.save();
      ctx.translate(x, y);          // all subsequent drawing in boss-local space
      ctx.rotate(this.facingAngle); // face toward player

      //ambient glow
      const outerGlow = ctx.createRadialGradient(0, 0, radius * 0.6, 0, 0, radius * 2.5);
      outerGlow.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.18)' : p2 ? `rgba(255, 30, 60, 0.15)` : `hsla(${hue},100%,55%,0.13)`);
      outerGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = outerGlow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 2.5, 0, 6.28);
      ctx.fill();

      //phase 2 enrage pulsing ring
      if (p2 && !isFlashing) {
        const va = 0.18 + 0.12 * Math.sin(phase * 3.5);
        ctx.strokeStyle = `rgba(255,20,50,${va})`;
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 2.2, 0, 6.28);
        ctx.stroke();
        ctx.strokeStyle = `rgba(255,60,90,${va * 0.5})`;
        ctx.lineWidth = 24;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 2.45, 0, 6.28);
        ctx.stroke();
      }

      //6 arms drawn before the body so the body overlaps them
      //arm root and tip positions are defined in local space
      //ax,ay = root attachment point on the body
      //tx,ty = arm tip end point
      const armDefs = [
        {ax: -radius * 0.08, ay: -radius * 0.72, tx: -radius * 1.55, ty: -radius * 1.55},
        {ax: -radius * 0.40, ay: -radius * 0.60, tx: -radius * 2.05, ty: -radius * 1.28},
        {ax: -radius * 0.68, ay: -radius * 0.38, tx: -radius * 2.38, ty: -radius * 0.68},
        {ax: -radius * 0.08, ay: radius * 0.72, tx: -radius * 1.55, ty: radius * 1.55},
        {ax: -radius * 0.40, ay: radius * 0.60, tx: -radius * 2.05, ty: radius * 1.28},
        {ax: -radius * 0.68, ay: radius * 0.38, tx: -radius * 2.38, ty: radius * 0.68}
      ];
      armDefs.forEach((def, i) => {
        const arm = arms[i];
        //phase2 increases arm waveAmp so tentacles are more violent
        const waveAmp = p2 ? 30 : 18;
        const dx = def.tx - def.ax, dy = def.ty - def.ay;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;

        //oscillation perpendicular to the arm vector.
        const wave = Math.sin(phase * 1.15 + arm.phase) * waveAmp;

        //control point = midpoint + perpendicular offset
        const ctrl = {
          x: (def.ax + def.tx) * 0.5 + (-dy / len) * wave,
          y: (def.ay + def.ty) * 0.5 + (dx / len) * wave
        };

        //black shadow stroke -> colored arm -> highlight streak
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 17;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(def.ax, def.ay);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, def.tx, def.ty);
        ctx.stroke();
        ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.78)' : `hsla(${hue + i * 12},70%,38%,0.85)`;
        ctx.lineWidth = 12;
        ctx.beginPath();
        ctx.moveTo(def.ax, def.ay);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, def.tx, def.ty);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(def.ax, def.ay);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, def.tx, def.ty);
        ctx.stroke();

        //dots along arm using quadratic bezier
        for (let t = 0.18; t <= 0.88; t += 0.17) {
          const mt = 1 - t;
          const bx = mt * mt * def.ax + 2 * mt * t * ctrl.x + t * t * def.tx;
          const by2 = mt * mt * def.ay + 2 * mt * t * ctrl.y + t * t * def.ty;

          const sr = 5.5 * (1 - t * 0.55);
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.beginPath();
          ctx.arc(bx, by2, sr, 0, 6.28);
          ctx.fill();
          ctx.fillStyle = isFlashing
            ? 'rgba(255,200,255,0.22)'
            : `hsla(${hue + 180},65%,62%,0.2)`;
          ctx.beginPath();
          ctx.arc(bx, by2, sr * 0.65, 0, 6.28);
          ctx.fill();
        }

        //glowing tip disc at each arm end
        const tg2 = ctx.createRadialGradient(def.tx, def.ty, 0, def.tx, def.ty, 18);
        tg2.addColorStop(0, isFlashing ? 'rgba(255,255,255,0.5)' : `hsla(${hue + 180},100%,72%,0.5)`);
        tg2.addColorStop(1, 'transparent');
        ctx.fillStyle = tg2;
        ctx.beginPath();
        ctx.arc(def.tx, def.ty, 18, 0, 6.28);
        ctx.fill();
        ctx.fillStyle = isFlashing ? '#fff' : `hsla(${hue + 180},100%,82%,0.9)`;
        ctx.beginPath();
        ctx.arc(def.tx, def.ty, 3.5, 0, 6.28);
        ctx.fill();
      });

      //body
      const bodyG = ctx.createRadialGradient(-radius * 0.22, -radius * 0.25, radius * 0.08, 0, 0, radius * 0.92);
      if (isFlashing) {
        bodyG.addColorStop(0, '#fff');
        bodyG.addColorStop(1, 'rgba(200,160,255,0.85)');
      } else if (p2) {
        bodyG.addColorStop(0, '#380008');
        bodyG.addColorStop(0.5, '#1c0004');
        bodyG.addColorStop(1, '#080001');
      } else {
        bodyG.addColorStop(0, '#1a0042');
        bodyG.addColorStop(0.5, '#0c0022');
        bodyG.addColorStop(1, '#04000f');
      }
      ctx.fillStyle = bodyG;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * pulse, radius * 0.82 * pulse, 0, 0, 6.28);
      ctx.fill();

      //rim light
      ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.38)' : `hsla(${hue},80%,52%,0.26)`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * pulse, radius * 0.82 * pulse, 0, 0, 6.28);
      ctx.stroke();

      //bioluminescent body spots
      for (let i = 0; i < 10; i++) {
        //alternate between inner and outer ring (0.42 and 0.28 of radius)
        const bAngle = i / 10 * 6.28 + phase * 0.04;
        const bDist = radius * (i % 2 === 0 ? 0.42 : 0.28);
        const bx = Math.cos(bAngle) * bDist, by = Math.sin(bAngle) * bDist * 0.82;

        //spot alpha pulses with its own offset so spots flicker asynchronously
        const ba = 0.1 + 0.22 * Math.abs(Math.sin(phase * 1.8 + i * 0.85));
        const bg2 = ctx.createRadialGradient(bx, by, 0, bx, by, radius * 0.11);
        bg2.addColorStop(0, isFlashing ? `rgba(255,255,255,${ba})` : `hsla(${hue + i * 18},100%,65%,${ba})`);
        bg2.addColorStop(1, 'transparent');
        ctx.fillStyle = bg2;
        ctx.beginPath();
        ctx.arc(bx, by, radius * 0.11, 0, 6.28);
        ctx.fill();
      }

      //secondary smaller head
      const hcx = radius * 0.55;
      const hrx = radius * 0.5;
      const hry = radius * 0.42;
      const headG = ctx.createRadialGradient(
        hcx - hrx * 0.25, -hry * 0.28, hrx * 0.04,
        hcx, 0, hrx
      );
      if (isFlashing) {
        headG.addColorStop(0, 'rgba(255,255,255,0.95)');
        headG.addColorStop(1, 'rgba(200,160,255,0.8)');
      } else if (p2) {
        headG.addColorStop(0, '#2e0006');
        headG.addColorStop(0.6, '#140003');
        headG.addColorStop(1, '#050001');
      } else {
        headG.addColorStop(0, '#120032');
        headG.addColorStop(0.6, '#080018');
        headG.addColorStop(1, '#020008');
      }
      ctx.fillStyle = headG;
      ctx.beginPath();
      ctx.ellipse(hcx, 0, hrx, hry, 0, 0, 6.28);
      ctx.fill();
      ctx.strokeStyle = isFlashing ? 'rgba(255,255,255,0.38)' : `hsla(${hue},80%,55%,0.26)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(hcx, 0, hrx, hry, 0, 0, 6.28);
      ctx.stroke();

      //eyes
      [-1, 1].forEach(side => {
        const ex = hcx + hrx * 0.05;
        const ey = side * hry * 0.52;
        const erx = hrx * 0.27, ery = hry * 0.38;

        ctx.fillStyle = 'rgba(0,0,0,0.92)';
        ctx.beginPath();
        ctx.ellipse(ex, ey, erx + 2.5, ery + 2, 0, 0, 6.28);
        ctx.fill();

        //iris
        const iris = ctx.createRadialGradient(ex, ey, 0, ex, ey, erx);
        iris.addColorStop(0, isFlashing ? 'rgba(255,255,200,0.95)' : `hsla(${hue + 188},90%,72%,0.92)`);
        iris.addColorStop(0.55, isFlashing ? 'rgba(200,180,80,0.7)' : `hsla(${hue + 168},68%,40%,0.7)`);
        iris.addColorStop(1, 'transparent');
        ctx.fillStyle = iris;
        ctx.beginPath();
        ctx.ellipse(ex, ey, erx, ery, 0, 0, 6.28);
        ctx.fill();

        //vertical pupil
        ctx.fillStyle = 'rgba(0,0,0,0.96)';
        ctx.beginPath();
        ctx.ellipse(ex, ey, erx * 0.2, ery * 0.86, 0, 0, 6.28);
        ctx.fill();

        //highlight
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.beginPath();
        ctx.arc(ex - erx * 0.28, ey - ery * 0.28, erx * 0.14, 0, 6.28);
        ctx.fill();

        //iris glow
        const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, erx * 1.9);
        eg.addColorStop(0, isFlashing ? 'rgba(255,255,100,0.28)' : `hsla(${hue + 188},100%,68%,0.22)`);
        eg.addColorStop(1, 'transparent');
        ctx.fillStyle = eg;
        ctx.beginPath();
        ctx.arc(ex, ey, erx * 1.9, 0, 6.28);
        ctx.fill();
      });

      //upper jaw
      const jx = hcx + hrx * 0.35;
      ctx.fillStyle = isFlashing ? 'rgba(255,255,255,0.9)' : p2 ? '#250009' : '#0c0028';
      ctx.beginPath();
      ctx.moveTo(jx - hrx * 0.22, -hry * 0.16);
      ctx.bezierCurveTo(jx + hrx * 0.08, -hry * 0.1, jx + hrx * 0.42, -hry * 0.04, jx + hrx * 0.58, 0);
      ctx.bezierCurveTo(jx + hrx * 0.42, hry * 0.04, jx - hrx * 0.04, hry * 0.04, jx - hrx * 0.22, hry * 0.12);
      ctx.closePath();
      ctx.fill();

      //5 triangles upper teeth
      ctx.fillStyle = isFlashing ? '#fff' : 'rgba(210,240,210,0.9)';
      for (let t = 0; t < 5; t++) {
        ttx = jx + hrx * (-0.14 + t * 0.13);
        ctx.beginPath();
        ctx.moveTo(ttx, -hry * 0.03);
        ctx.lineTo(ttx + hrx * 0.045, -hry * 0.16);
        ctx.lineTo(ttx + hrx * 0.088, -hry * 0.03);
        ctx.closePath();
        ctx.fill();
      }

      //lower jaw
      const jawDrop = jawAmt * hry * 0.7;
      ctx.fillStyle = isFlashing ? 'rgba(255,255,255,0.9)' : p2 ? '#250009' : '#0c0028';
      ctx.beginPath();
      ctx.moveTo(jx - hrx * 0.22, hry * 0.16 + jawDrop * 0.3);
      ctx.bezierCurveTo(jx + hrx * 0.08, hry * 0.1 + jawDrop * 0.88, jx + hrx * 0.42, hry * 0.04 + jawDrop, jx + hrx * 0.58, jawDrop);
      ctx.bezierCurveTo(jx + hrx * 0.42, -hry * 0.04 + jawDrop * 0.1, jx - hrx * 0.04, -hry * 0.04 + jawDrop * 0.05, jx - hrx * 0.22, hry * 0.12 + jawDrop * 0.3);
      ctx.closePath();
      ctx.fill();

      //mouth cavity glow only visible when jaw is open
      if (jawAmt > 0.08) {
        const mg = ctx.createRadialGradient(jx + hrx * 0.15, jawDrop * 0.5, 0, jx + hrx * 0.15, jawDrop * 0.5, hrx * 0.38);
        mg.addColorStop(0, p2 ? `rgba(255,40,40,${jawAmt * 0.8})` : `rgba(180,40,255,${jawAmt * 0.8})`);
        mg.addColorStop(1, 'transparent');
        ctx.fillStyle = mg;
        ctx.beginPath();
        ctx.ellipse(jx + hrx * 0.15, jawDrop * 0.5, hrx * 0.32, hry * 0.18 + jawDrop * 0.35, 0, 0, 6.28);
        ctx.fill();
      }

      //4 triangles lower teeth
      ctx.fillStyle = isFlashing ? '#fff' : 'rgba(210,240,210,0.9)';
      for (let t = 0; t < 4; t++) {
        ttx = jx + hrx * (-0.1 + t * 0.14);
        const tty = jawDrop * 0.72;
        ctx.beginPath();
        ctx.moveTo(ttx, tty);
        ctx.lineTo(ttx + hrx * 0.05, tty + hry * 0.14);
        ctx.lineTo(ttx + hrx * 0.095, tty);
        ctx.closePath();
        ctx.fill();
      }

      //phase2 scar red cracks
      if (p2) {
        [
          [
            {x: -radius * 0.5, y: radius * 0.1},
            {x: -radius * 0.24, y: radius * 0.3},
            {x: -radius * 0.09, y: radius * 0.06}
          ],
          [
            {x: radius * 0.32, y: -radius * 0.28},
            {x: radius * 0.12, y: 0},
            {x: radius * 0.38, y: radius * 0.18}
          ]
        ].forEach((pts, ci) => {
          const ca = 0.5 + 0.45 * Math.sin(phase * 2.5 + ci);
          ctx.strokeStyle = `rgba(255,${45 + ci * 35},${ci * 18},${ca})`;
          ctx.lineWidth = 2.2;
          ctx.shadowColor = 'rgba(255,30,50,0.8)';
          ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
          ctx.stroke();

          pts.forEach(p => {
            const cg2 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12);
            cg2.addColorStop(0, `rgba(255,75,55,${ca * 0.55})`);
            cg2.addColorStop(1, 'transparent');
            ctx.fillStyle = cg2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 12, 0, 6.28);
            ctx.fill();
          });
          ctx.shadowBlur = 0;
        });
      }

      ctx.restore();

      //health bar
      const bw = 440;
      const bh = 16;
      const bx2 = (CLIENT_WIDTH - bw) / 2;
      const by2 = CLIENT_HEIGHT - 32;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.fillRect(bx2 - 3, by2 - 16, bw + 6, bh + 20);

      const hpG = ctx.createLinearGradient(bx2, 0, bx2 + bw, 0);
      if (p2) {
        hpG.addColorStop(0, '#cc0020');
        hpG.addColorStop(0.5, '#ff2050');
        hpG.addColorStop(1, '#ff6080');
      } else {
        hpG.addColorStop(0, '#4400cc');
        hpG.addColorStop(0.5, '#8800ff');
        hpG.addColorStop(1, '#cc44ff');
      }
      ctx.fillStyle = hpG;
      ctx.fillRect(bx2, by2, bw * (this.health / this.maxHealth), bh);

      //pulsing inner shimmer strip
      const sa = 0.22 + 0.14 * Math.sin(gTime * 0.18);
      ctx.fillStyle = p2 ? `rgba(255,180,180,${sa})` : `rgba(200,120,255,${sa})`;
      ctx.fillRect(bx2, by2 + 1, bw * (this.health / this.maxHealth), 5);

      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx2, by2, bw, bh);

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = 'bold 11px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText('THE LEVIATHAN', CLIENT_WIDTH / 2, by2 - 4);

      ctx.restore();
    }
  }

  //each entry in WAVE_CONFIG describes one wave's rules:
  //id         = display index (1-based)
  //goal       = kill target before advancing to the next wave
  //spawnRate  = frames between spawn attempts (lower = faster spawning)
  //maxEnemies = cap on simultaneous live enemies (prevents screen flooding)
  //pool       = weighted list of enemy types
  //shooters   = which pool types can shoot in this wave (enabled via canShoot)
  const WAVE_CONFIG = [
    {
      id: 1, goal: 8, spawnRate: 80, maxEnemies: 8,
      pool: [{type: 'jellyfish', weight: 3}],
      shooters: []                                    //no shooters in wave 1
    },
    {
      id: 2, goal: 10, spawnRate: 65, maxEnemies: 10,
      pool: [{type: 'jellyfish', weight: 2}, {type: 'puffer', weight: 2}],
      shooters: ['puffer']                            //puffers can shoot
    },
    {
      id: 3, goal: 12, spawnRate: 50, maxEnemies: 12,
      pool: [
        {type: 'jellyfish', weight: 1},
        {type: 'puffer', weight: 2},
        {type: 'anglerfish', weight: 1}
      ],
      shooters: ['puffer', 'anglerfish']              //both shooter types enabled
    }
  ];

  //stateless factory object
  //_EdgePos() picks a random point just off-screen (+-6 60px) on one of the four edges
  const EnemyFactory = {
    _EdgePos() {
      const side = ~~(Math.random() * 4);
      if (side === 0) return {x: Math.random() * CLIENT_WIDTH, y: -60};                 //top
      if (side === 1) return {x: CLIENT_WIDTH + 60, y: Math.random() * CLIENT_HEIGHT};  //right
      if (side === 2) return {x: Math.random() * CLIENT_WIDTH, y: CLIENT_HEIGHT + 60};  //bottom
      return {x: -60, y: Math.random() * CLIENT_HEIGHT};                                //left
    },

    Create(type, waveNum, canShoot) {
      const {x, y} = this._EdgePos();
      switch (type) {
        case 'jellyfish':
          return new Jellyfish(x, y, waveNum);
        case 'puffer':
          return new Puffer(x, y, waveNum, canShoot);
        case 'anglerfish':
          return new Anglerfish(x, y, waveNum, canShoot);
        default:
          throw new Error(`Unknown enemy type: "${type}"`);
      }
    },

    //weighted random selection from the wave pool
    //iterates through the pool subtracting each weight from a random [0,total]
    //the first entry that drives the accumulator to <= 0 is chosen.
    FromConfig(cfg, waveNum) {
      const total = cfg.pool.reduce((s, e) => s + e.weight, 0);
      let rand = Math.random() * total;
      for (const entry of cfg.pool) {
        rand -= entry.weight;
        if (rand <= 0)
          return this.Create(entry.type, waveNum, cfg.shooters.includes(entry.type));
      }
      //fallback to first pool entry
      return this.Create(cfg.pool[0].type, waveNum, false);
    }
  };

  //controls the game progression (wave spawning, inter-wave transitions, and the trigger for the boss phase)
  //playing    = actively spawning enemies and counting kills
  //waiting"   = kill goal reached, waiting for screen to clear (0 enemies)
  //transition = a banner is displayed between waves and before the boss
  //boss       = boss phase has begun (spawning is suppressed)

  //enemyCount < maxEnemies  (don't overpopulate)
  //kills + enemyCount < goal + 4  (don't spawn more than needed)
  class WaveManager {
    constructor() {
      this.waveIndex = 0;     //index into WAVE_CONFIG
      this.kills = 0;         //enemies killed in the current wave
      this.spawnTimer = 0;    //frames since last spawn
      this.phase = 'playing';
      this._bannerMessage = '';
      this._bannerTimer = 0;
      this._bannerDuration = 0;
      this._nextGamePhase = 'playing';
    }

    get Config() {
      return WAVE_CONFIG[this.waveIndex];
    }

    get WaveNum() {
      return this.waveIndex + 1;
    }

    get IsLastWave() {
      return this.waveIndex >= WAVE_CONFIG.length - 1;
    }

    get IsBossPhase() {
      return this.phase === 'boss';
    }

    OnKill() {
      this.kills++;
    }

    //starts the inter-wave/pre-boss banner transition
    _StartTransition(msg, dur, nextGamePhase) {
      this.phase = 'transition';
      this._bannerMessage = msg;
      this._bannerTimer = this._bannerDuration = dur; //countdown = full duration
      this._nextGamePhase = nextGamePhase;
    }

    //returns a new Enemy instance to spawn or null if should not spawn
    Update(enemyCount) {
      if (this.phase === 'transition') {
        this._bannerTimer--;
        if (this._bannerTimer <= 0) this.phase = this._nextGamePhase;
        return null;
      }
      if (this.phase !== 'playing') return null;

      //check wave completion condition
      if (this.kills >= this.Config.goal && enemyCount === 0) {
        this.phase = 'waiting'; //prevent repeated triggers
        setTimeout(() => {
          if (this.IsLastWave) {
            //show "BOSS INCOMING" for 260 frames and switch to boss phase
            this._StartTransition('BOSS INCOMING', 260, 'boss');
          } else {
            //advance to next wave config and show numbered wave banner
            this.waveIndex++;
            this.kills = 0;
            this.spawnTimer = 0;
            this._StartTransition(`WAVE ${this.WaveNum}`, 180, 'playing');
          }
        }, 800); //small delay so the last enemy death animation can finish
        return null;
      }

      //spawn throttle (two gates must pass before a spawn is attempted)
      const cfg = this.Config;
      if (enemyCount < cfg.maxEnemies && (this.kills + enemyCount) < cfg.goal + 4) {
        this.spawnTimer++;
        if (this.spawnTimer >= cfg.spawnRate) {
          this.spawnTimer = 0;
          return EnemyFactory.FromConfig(cfg, this.WaveNum);
        }
      }
      return null;
    }

    //draws the wave/boss transition banner
    //elapsed     = _bannerDuration - _bannerTimer (frames since banner started)
    //fadeIn      = min(1, elapsed / 30)           (ramps 0->1 over first 30 frames)
    //fadeOut     = min(1, _bannerTimer / 30)      (ramps 0->1 as timer counts down the last 30)
    //bannerAlpha = fadeIn * fadeOut               (product gives symmetric fade in/out)
    DrawHUD() {
      if (this.phase !== 'transition')
        return;

      const elapsed = this._bannerDuration - this._bannerTimer;
      const bannerAlpha = Math.min(Math.min(1, elapsed / 30), Math.min(1, this._bannerTimer / 30));
      const isBoss = this._bannerMessage.includes('BOSS');

      ctx.save();
      //dark background
      ctx.globalAlpha = bannerAlpha * 0.8;
      ctx.fillStyle = 'rgba(0,8,20,0.7)';
      ctx.fillRect(0, CLIENT_HEIGHT * 0.317, CLIENT_WIDTH, CLIENT_HEIGHT * 0.367);

      ctx.globalAlpha = bannerAlpha;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#00d4ff';
      ctx.shadowBlur = 35;
      ctx.fillStyle = isBoss ? '#ff6080' : '#7ff9ff';
      ctx.font = `bold ${isBoss ? 56 : 50}px Segoe UI`;
      ctx.fillText(this._bannerMessage, CLIENT_WIDTH / 2, CLIENT_HEIGHT * 0.483);

      ctx.shadowBlur = 12;
      ctx.font = '17px Segoe UI';
      ctx.fillStyle = isBoss ? '#faa' : '#aef';
      ctx.restore();
    }
  }

  //DrawHUD() persistent in-game health, score, wave, power-up timers
  //DrawOverlay() full-screen overlay for title, game over, and victory
  const UI = {
    Update(player, waveNum, isBoss) {
      //snapshot the current game state into hudState
      hudState.hp = Math.max(0, Math.ceil(player.health));
      hudState.waveNum = waveNum;
      hudState.isBoss = isBoss;
      //powerup countdown convert remaining frames to whole seconds
      if (player.shieldActive || player.multishot) {
        hudState.powerupText =
          (player.shieldActive ? `🛡 ${Math.ceil(player.shieldTimer / 60)}s ` : '') +
          (player.multishot ? `🔫 ${Math.ceil(player.multishotTimer / 60)}s` : '');
      } else {
        hudState.powerupText = '';
      }
    },

    DrawHUD() {
      ctx.save();
      ctx.font = '600 14px "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      ctx.shadowColor = '#00d4ff';
      ctx.shadowBlur = 10;
      ctx.restore();
    },

    //used for the title screen, game-over, and victory
    //skips rendering if overlayState.visible is false
    DrawOverlay() {
      if (!overlayState.visible) return;
      ctx.save();
      ctx.fillStyle = 'rgba(0,10,30,0.88)';
      ctx.fillRect(0, 0, CLIENT_WIDTH, CLIENT_HEIGHT);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cx = CLIENT_WIDTH / 2, cy = CLIENT_HEIGHT / 2;

      //glow title
      ctx.shadowColor = '#00d4ff';
      ctx.shadowBlur = 30;
      ctx.fillStyle = '#7ff9ff';
      ctx.font = 'bold 52px "Segoe UI", sans-serif';
      ctx.fillText(overlayState.title, cx, cy - 90);

      //subtitle and control hints
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#aef';
      ctx.font = '15px "Segoe UI", sans-serif';
      ctx.fillText(overlayState.sub, cx, cy - 44);
      ctx.fillStyle = '#88ccff';
      ctx.fillText('WASD — Move  |  Mouse — Aim  |  Click — Shoot', cx, cy - 16);
      ctx.fillText('Collect dropped pills:  🛡 Shield  |  🔫 Multishot', cx, cy + 8);

      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(Date.now() / 400);
      ctx.shadowColor = '#00d4ff';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#7ff9ff';
      ctx.font = 'bold 18px "Segoe UI", sans-serif';
      ctx.letterSpacing = '4px';
      ctx.fillText('PRESS  ENTER  TO  START', cx, cy + 72);
      ctx.globalAlpha = 1;
      ctx.restore();
    },

    ShowOverlay(title, sub) {
      overlayState.title = title;
      overlayState.sub = sub;
      overlayState.visible = true;
    },

    HideOverlay() {
      overlayState.visible = false;
    }
  };

  //audio is synthesized with the Web Audio API
  //the signal graph looks like this:
  //[Oscillators / BufferSources]
  //  [BiquadFilters]           (shape spectrum)
  //    [Gain nodes]            (envelope / volume)
  //      ambMaster             (global GainNode, fades in/out on start/stop)
  //        ambCtx.destination  (speakers)
  //
  //the ambient atmosphere has three layers that run in parallel:
  //1) Drone   = 2 sine oscillators detuned from each other (50 Hz and 53.2 Hz) producing a slow ~3 Hz tremolo
  //             both pass through a low-pass filter at 155 Hz to cut harsh harmonics
  //2) Breath  = recurring cycle of inhale+exhale sounds built from brown noise
  //             (filtered and amplitude-enveloped) plus a bubble cluster on exhale
  //3) Bubbles = random single or grouped bubbles fired at irregular intervals (1400–8400ms)

  let ambCtx = null;      //the AudioContext (null until StartAmbience() is called)
  let ambMaster = null;   //top-level GainNode for master volume control
  let ambActive = false;  //guards against re-entry and orphaned timeouts
  let ambToutIDs = [];    //setTimeout IDs (cleared in StopAmbience() to stop all scheduled sounds)
  let ambDrones = [];     //references to always-on oscillators/sources for cleanup

  let bossMusicActive;
  let bossMusicTids;
  let bossMusicGain;


  //generates a buffer of Brownian noise
  //-6 dB/octave power spectrum (more low-frequency energy than white noise)
  //which sounds like a deep rumble or distant thunder

  //noise is the integral of white noise (each sample is the previous sample + a tiny white-noise
  //perturbation then divided back by aconstant to keep it from drifting):
  // w     = random in [-1, 1]      (white noise sample)
  // d[i]  = (last + 0.02 * w)/1.02 (division applies a high-pass pole that prevents DC drift)
  // last  = d[i]                   (feeds the next sample)
  function AmbMakeBrown(secs) {
    const sr = ambCtx.sampleRate;
    const n = Math.ceil(sr * secs);
    const buf = ambCtx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;  //uniform white noise in [-1,1]
      d[i] = (last + 0.02 * w) / 1.02;  //integrate + high-pass pole
      last = d[i];
      d[i] *= 3.5;                      //gain up
      if (d[i] > 1) d[i] = 1;           //hard clip
      if (d[i] < -1) d[i] = -1;
    }
    return buf;
  }

  //generates a buffer of white noise
  //each sample is independently uniformly distributed on [-1, 1]
  //white noise has equal energy at all frequencies used for the snare, hi-hat, click, and gun noise
  function AmbMakeWhite(secs) {
    const sr = ambCtx.sampleRate;
    const n = Math.ceil(sr * secs);
    const buf = ambCtx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  //sine oscillator with a short exponential frequency glide (freq -> freq*1.07) combined with a fast attack and
  //exponential-decay amplitude envelope
  //
  //frequency rises slightly from start to end, shrinking as it rises (smaller -> higher resonant frequency)
  //time:  AudioContext scheduled time in seconds
  //freq:  Starting frequency (Hz)
  //size:  scale [0-1]
  function AmbPlayBubble(time, freq, size) {
    const osc = ambCtx.createOscillator();
    const gain = ambCtx.createGain();
    const dur = 0.03 + size * 0.11 + Math.random() * 0.05; //bigger bubble = longer pop
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    //exponential frequency glide upward gives the bubble "blip"
    osc.frequency.exponentialRampToValueAtTime(freq * (1.07 + size * 0.12), time + dur);

    //fast attack then exponential decay to near-silence
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.011 + Math.random() * 0.018 * size, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(gain);
    gain.connect(ambMaster);
    osc.start(time);
    osc.stop(time + dur + 0.04);
  }

  //cluster of bubbles used at the end of each breath to simulate the rush of air
  function AmbPlayCluster(t0, count, spread) {
    for (let i = 0; i < count; i++)
      AmbPlayBubble(t0 + Math.random() * spread, 200 + Math.random() * 700, 0.3 + Math.random() * 0.95);
  }

  //short transient click at the start of each breath cycle
  //white noise filtered to a narrowband 1050Hz (bandpass Q=0.55) giving a dull valve "tock"
  function AmbPlayClick(time) {
    const src = ambCtx.createBufferSource();
    const filt = ambCtx.createBiquadFilter();
    const gain = ambCtx.createGain();
    src.buffer = AmbMakeWhite(0.055);
    filt.type = 'bandpass';
    filt.frequency.value = 1050;
    filt.Q.value = 0.55;
    gain.gain.setValueAtTime(0.06, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.048);
    src.connect(filt);
    filt.connect(gain);
    gain.connect(ambMaster);
    src.start(time);
    src.stop(time + 0.07);
  }


  //breath stroke from brown noise passed through a bandpass filter with a time-varying cutoff frequency
  //inhale = filter frequency sweeps 255 -> 490 -> 340 Hz
  //         slow rise reaches peak at 28% of duration then fall
  //
  //exhale = starts high (430 Hz) spikes quickly (700 Hz) then falls (275 Hz)
  //         fast rise (peak at 10% of duration) then long gradual fade
  function AmbPlayBreath(time, type) {
    const dur = 1.5 + Math.random() * 0.9; // each breath is 1.5–2.4 seconds
    const src = ambCtx.createBufferSource();
    const filt = ambCtx.createBiquadFilter();
    const gain = ambCtx.createGain();
    src.buffer = AmbMakeBrown(dur + 0.3);
    filt.type = 'bandpass';

    if (type === 'inhale') {
      //filter 255Hz rise to 490Hz (mid-point) then drop to 340Hz
      filt.frequency.setValueAtTime(255, time);
      filt.frequency.linearRampToValueAtTime(490, time + dur * 0.5);
      filt.frequency.linearRampToValueAtTime(340, time + dur);
      filt.Q.value = 1.7; //moderate resonance

      //amplitude: slow ramp in, peak at 28%, gradual fade
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.17, time + dur * 0.28);
      gain.gain.linearRampToValueAtTime(0.07, time + dur);
      gain.gain.linearRampToValueAtTime(0, time + dur + 0.1);
    } else {
      //exhale: quick spike at 10% then long descent
      filt.frequency.setValueAtTime(430, time);
      filt.frequency.linearRampToValueAtTime(700, time + dur * 0.18);
      filt.frequency.linearRampToValueAtTime(275, time + dur);
      filt.Q.value = 1.3;
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.22, time + dur * 0.1);
      gain.gain.linearRampToValueAtTime(0.12, time + dur * 0.68);
      gain.gain.linearRampToValueAtTime(0, time + dur + 0.1);
    }
    src.connect(filt);
    filt.connect(gain);
    gain.connect(ambMaster);
    src.start(time);
    src.stop(time + dur + 0.2);

    //duration of this breath in seconds (used to schedule the next)
    return dur;
  }

  //orchestrates one full breath cycle: click -> inhale -> exhale -> bubbles
  //recursively schedules the next cycle via setTimeout using the audio clock ambCtx.currentTime
  function AmbBreathCycle(t) {
    if (!ambActive) return;
    AmbPlayClick(t);
    const inDur = AmbPlayBreath(t, 'inhale');
    const exStart = t + inDur + 0.1 + Math.random() * 0.15; // tiny gap between in/out
    const exDur = AmbPlayBreath(exStart, 'exhale');

    //bubble cluster fires midway through the exhale
    AmbPlayCluster(exStart + exDur * 0.52, 9 + Math.floor(Math.random() * 9), 0.8);

    //next breath cycle starts 3.5–9 seconds after the exhale ends.
    const nextTime = exStart + exDur + 3.5 + Math.random() * 5.5;
    ambToutIDs.push(setTimeout(
      () => AmbBreathCycle(nextTime),
      Math.max(50, (nextTime - ambCtx.currentTime) * 1000 - 300)
      //300ms ensures the setTimeout fires 300ms before the audio is needed giving the browser
      //enough time to schedule with audio engine
    ));
  }

  //random bubble pops at irregular intervals (1.4s – 8.4s)
  //with 28% probability a small cluster (2–4 bubbles) is spawned otherwise a single bubble is played
  function AmbStrayBubble() {
    if (!ambActive) return;
    ambToutIDs.push(setTimeout(() => {
      if (!ambActive) return;
      const now = ambCtx.currentTime;
      if (Math.random() < 0.28) {
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++)
          AmbPlayBubble(now + Math.random() * 0.35, 480 + Math.random() * 620, 0.2 + Math.random() * 0.4);
      } else {
        AmbPlayBubble(now, 320 + Math.random() * 820, 0.15 + Math.random() * 0.55);
      }
      AmbStrayBubble(); //schedule the next random bubble
    }, 1400 + Math.random() * 7000));
  }

  //2 sine oscillators at 50Hz and 53.2Hz
  //3.2Hz frequency difference causes them to beat against each other producing a slow wavering throb
  //at ~3.2 times per second (the classic deep submarine sound)
  //both are vibrato-modulated by separate LFOs at ~0.03–0.05 Hz to prevent the sounding static
  //a low-pass filter at 155 Hz cuts everything above the fundamental range so it's felt more than heard
  //looping brown noise filtered to < 105Hz adds a quiet sub-bass rumble underneath
  function AmbStartDrone() {
    //mkSine builds LFO -> LFO-gain -> osc.frequency vibrato modulation
    //osc -> caller (to connect to the filter)
    const mkSine = freq => {
      const osc = ambCtx.createOscillator();
      const lfo = ambCtx.createOscillator();
      const lfoG = ambCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      lfo.type = 'sine';
      lfo.frequency.value = 0.03 + Math.random() * 0.018; //slow vibrato
      lfoG.gain.value = 4.5;                              //vibrato depth = +-4.5 Hz
      lfo.connect(lfoG);
      lfoG.connect(osc.frequency); //modulate pitch
      osc.start();
      lfo.start();
      ambDrones.push(osc, lfo);
      return osc;
    };

    const filt = ambCtx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 155;
    const gn = ambCtx.createGain();
    gn.gain.value = 0.038;
    mkSine(50).connect(filt);   //50Hz
    mkSine(53.2).connect(filt); //53.2Hz - 3.2Hz beat frequency
    filt.connect(gn);
    gn.connect(ambMaster);

    //brown noise sub-bass
    const nSrc = ambCtx.createBufferSource(), nFil = ambCtx.createBiquadFilter(), nGn = ambCtx.createGain();
    nSrc.buffer = AmbMakeBrown(9); //9 second buffer looped seamlessly
    nSrc.loop = true;
    nFil.type = 'lowpass';
    nFil.frequency.value = 105;
    nGn.gain.value = 0.018;
    nSrc.connect(nFil);
    nFil.connect(nGn);
    nGn.connect(ambMaster);
    nSrc.start();
    ambDrones.push(nSrc);
  }

  //1) creates a new AudioContext
  //2) creates the master gain node and fades it in over 2.5s
  //3) starts the layer (runs permanently)
  //4) schedules the first breath cycle 1.4s
  //5) starts the bubble scheduler
  function StartAmbience() {
    if (ambActive) StopAmbience(); //shut down any previous context first
    ambCtx = new (window.AudioContext || window.webkitAudioContext)();
    ambMaster = ambCtx.createGain();

    //fade master volume from 0 -> 0.75 over 2.5s to avoid a harsh start
    ambMaster.gain.setValueAtTime(0, ambCtx.currentTime);
    ambMaster.gain.linearRampToValueAtTime(0.75, ambCtx.currentTime + 2.5);
    ambMaster.connect(ambCtx.destination);
    ambActive = true;
    AmbStartDrone();
    AmbBreathCycle(ambCtx.currentTime + 1.4);
    AmbStrayBubble();
  }

  //1) sets ambActive = false so recursive schedulers stop queuing new sounds
  //2) fades the master gain to 0 over 1.4s
  //3) clears all pending setTimeout IDs so no new audio nodes are created
  //4) after 1.6s stops all nodes and release audio resources
  function StopAmbience() {
    ambActive = false;
    bossMusicActive = false;
    if (!ambMaster)
      return;
    ambMaster.gain.linearRampToValueAtTime(0, ambCtx.currentTime + 1.4);

    //cancel all pending scheduled sound timers
    ambToutIDs.forEach(t => clearTimeout(t));
    ambToutIDs = [];
    bossMusicTids.forEach(t => clearTimeout(t));
    bossMusicTids = [];

    //after the fade completes stop nodes and close context
    setTimeout(() => {
      ambDrones.forEach(n => {
        try {
          n.stop();
        } catch (e) {
        }
      });
      ambDrones = [];
      if (ambCtx) {
        ambCtx.close();
        ambCtx = null;
      }
      ambMaster = null;
      bossMusicGain = null;
    }, 1600);
  }


  //underwater gunshot from three simultaneous layers:
  //thud   = triangle oscillator 130 -> 44Hz exponential glide in 80ms
  //         triangles has strong harmonics but no high-end sharpness giving a thunk rather than a crack
  //sub    = sine oscillator 65 -> 28Hz in 70ms adds a deep subwoofer punch
  //noise  = 100ms of white noise bandpass-filtered around 320 Hz (Q=1.3) mid-band represents the water disturbance
  //bubble = 3–5 small high-pitched bubbles fired 50–100 ms after the shot
  function AmbPlayGunShot() {
    if (!ambCtx || !ambMaster || !ambActive)
      return;
    const t = ambCtx.currentTime;

    const thud = ambCtx.createOscillator();
    const thudG = ambCtx.createGain();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(130, t);
    thud.frequency.exponentialRampToValueAtTime(44, t + 0.08);  //pitch drops fast
    thudG.gain.setValueAtTime(0, t);
    thudG.gain.linearRampToValueAtTime(0.38, t + 0.003);        //very fast attack (3 ms)
    thudG.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    thud.connect(thudG);
    thudG.connect(ambMaster);
    thud.start(t);
    thud.stop(t + 0.15);

    const sub = ambCtx.createOscillator(), subG = ambCtx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(65, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.07);
    subG.gain.setValueAtTime(0, t);
    subG.gain.linearRampToValueAtTime(0.22, t + 0.002);         //2 ms attack
    subG.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    sub.connect(subG);
    subG.connect(ambMaster);
    sub.start(t);
    sub.stop(t + 0.12);

    const nSrc = ambCtx.createBufferSource();
    const nFilt = ambCtx.createBiquadFilter();
    const nGn = ambCtx.createGain();
    nSrc.buffer = AmbMakeWhite(0.1);
    nFilt.type = 'bandpass';
    nFilt.frequency.value = 320;
    nFilt.Q.value = 1.3;
    nGn.gain.setValueAtTime(0, t);
    nGn.gain.linearRampToValueAtTime(0.12, t + 0.004);
    nGn.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    nSrc.connect(nFilt);
    nFilt.connect(nGn);
    nGn.connect(ambMaster);
    nSrc.start(t);
    nSrc.stop(t + 0.11);

    const count = 3 + Math.floor(Math.random() * 3); //3–5 bubbles
    for (let i = 0; i < count; i++)
      AmbPlayBubble(t + 0.05 + i * 0.015 + Math.random() * 0.02, 450 + Math.random() * 550, 0.1 + Math.random() * 0.18);
  }

  //procedural boss theme 4-bar looping tracker 152 bpm
  //BEAT_DUR       = 60 / 152 = 394 ms  (1 quarter note)
  //EIGHTH_NOTE    = BEAT_DUR / 2       (hi-hat subdivision)
  //SIXTEENTH_NOTE = BEAT_DUR / 4       (arpeggio subdivision)

  //lookup object maps note names (A1, Bb1, ...A5) to their exact equal-temperament frequencies in Hz
  //temperament formula:
  //f(n) = 440 × 2^((n-69)/12) where n is MIDI note number

  //kick:   beats 1 and 3  (classic four-on-the-floor pattern, but with 2 kicks)
  //snare:  beats 2 and 4  (backbeat)
  //hi-hat: every 8th note (16 per bar total, 8 per 4 beats)
  //bass:   one note per beat, from the bar's bass[] array
  //arp:    4 notes repeated 4 times at 16th-note rate (16 arpeggio hits per bar)
  //lead:   sustained melody notes from the bar's lead[] array

  //BmScheduleBar() is called with an absolute audio-clock start time
  //BmNote()  — generic synth note: oscillator + ADSR-like gain envelope
  //BmLead()  — sawtooth lead with vibrato (LFO kicks in after 80 ms for a classic synth lead feel
  //BmKick()  — sine oscillator with fast pitch drop 90 → 30 Hz (classic 808-style kick synthesis)
  //BmSnare() — bandpass-filtered white noise (1400 Hz, Q=0.7) + triangle oscillator at 185 Hz for the body tone
  //BmHiHat() — high-pass filtered white noise above 7500 Hz; very short (25 ms decay) for a tight closed hat
  //chords Dm -> F -> Bb -> Am
  //Dm -> F major → Bb major → A minor = minor loop

  bossMusicActive = false;
  bossMusicTids = [];
  bossMusicGain = null;
  const BOSS_BPM = 152;
  const BEAT_DUR = 60 / BOSS_BPM; //quarter-note duration sec
  const EIGHTH_NOTE = BEAT_DUR / 2;
  const SIXTEENTH_NOTE = BEAT_DUR / 4;

  //precalculated note frequencies Hz
  const NOTE = {
    A1: 55, Bb1: 58.27, C2: 65.41, Cs2: 69.30, D2: 73.42, E2: 82.41, F2: 87.31,
    G2: 98, A2: 110, Bb2: 116.54, C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61,
    G3: 196, A3: 220, Bb3: 233.08, C4: 261.63, Cs4: 277.18, D4: 293.66, E4: 329.63,
    F4: 349.23, G4: 392, A4: 440, Bb4: 466.16, C5: 523.25, Cs5: 554.37, D5: 587.33,
    E5: 659.25, F5: 698.46, G5: 783.99, A5: 880
  };

  //generic instrument note: oscillator with a basic Attack-Sustain-Release envelope
  //attack:  6ms linear ramp from 0 -> amp
  //sustain: linear ramp from amp -> amp*0.5 over the first 40% of the note
  //release: exponential decay to near-zero over the remaining 60%

  //time = AudioContext scheduled start time (sec)
  //freq = Pitch in Hz
  //wave = OscillatorType: sine, square, sawtooth, triangle
  //dur  = Note duration in sec
  //amp  = Peak amplitude (gain)
  //dest = Destination GainNode (usually bossMusicGain)
  function BmNote(time, freq, wave, dur, amp, dest) {
    const o = ambCtx.createOscillator(), e = ambCtx.createGain();
    o.type = wave;
    o.frequency.value = freq;
    e.gain.setValueAtTime(0, time);
    e.gain.linearRampToValueAtTime(amp, time + 0.006);           //6 ms attack
    e.gain.linearRampToValueAtTime(amp * 0.5, time + dur * 0.4); //sustain decay
    e.gain.exponentialRampToValueAtTime(0.001, time + dur);      //release
    o.connect(e);
    e.connect(dest);
    o.start(time);
    o.stop(time + dur + 0.02);
  }

  //lead melody instrument: sawtooth oscillator with delayed vibrato
  //the LFO (5.8 Hz, +-6 Hz depth) starts at 0 gain and ramps to full over the first 220 ms of the note
  function BmLead(time, freq, dur, dest) {
    const o = ambCtx.createOscillator(), lfo = ambCtx.createOscillator();
    const lfoG = ambCtx.createGain(), e = ambCtx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    lfo.type = 'sine';
    lfo.frequency.value = 5.8;

    //vibrato depth ramp: 0 -> 0 for first 80 ms, then 0 -> 6Hz by 220ms
    lfoG.gain.setValueAtTime(0, time);
    lfoG.gain.linearRampToValueAtTime(0, time + 0.08);   //no vibrato at onset
    lfoG.gain.linearRampToValueAtTime(6, time + 0.22);   //full vibrato depth
    lfo.connect(lfoG);
    lfoG.connect(o.frequency);

    //amplitude envelope: quick attack, sustain at 62%, exponential release
    e.gain.setValueAtTime(0, time);
    e.gain.linearRampToValueAtTime(0.13, time + 0.008);
    e.gain.linearRampToValueAtTime(0.08, time + dur * 0.55);
    e.gain.exponentialRampToValueAtTime(0.001, time + dur);
    o.connect(e);
    e.connect(dest);
    o.start(time);
    o.stop(time + dur + 0.02);
    lfo.start(time);
    lfo.stop(time + dur + 0.02);
  }

  //drum: sine oscillator with a fast exponential pitch drop (90 -> 30Hz in 100ms) and short decay (160ms)
  //the exponential frequency glide is what makes it sound "punchy" rather than flat
  function BmKick(time, dest) {
    const o = ambCtx.createOscillator(), e = ambCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, time);
    o.frequency.exponentialRampToValueAtTime(30, time + 0.1);
    e.gain.setValueAtTime(0.5, time);
    e.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    o.connect(e);
    e.connect(dest);
    o.start(time);
    o.stop(time + 0.18);
  }

  //snare drum: two simultaneous layers mixed together
  //noise: white noise bandpass-filtered at 1400 Hz (Q=0.7) with a fast 100 ms decay
  //body: triangle oscillator at 185Hz 55ms decay
  function BmSnare(time, dest) {
    const n = ambCtx.createBufferSource(), f = ambCtx.createBiquadFilter(), e = ambCtx.createGain();
    n.buffer = AmbMakeWhite(0.12);
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 0.7;
    e.gain.setValueAtTime(0.2, time);
    e.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    n.connect(f);
    f.connect(e);
    e.connect(dest);
    n.start(time);
    n.stop(time + 0.13);
    const o = ambCtx.createOscillator(), ge = ambCtx.createGain();
    o.type = 'triangle';
    o.frequency.value = 185;
    ge.gain.setValueAtTime(0.1, time);
    ge.gain.exponentialRampToValueAtTime(0.001, time + 0.055);
    o.connect(ge);
    ge.connect(dest);
    o.start(time);
    o.stop(time + 0.07);
  }

  //hi-hat: white noise high-pass filtered above 7500 Hz extremely short decay (25 ms)
  //the high-pass removes everything below the shimmery upper frequencies
  function BmHiHat(time, dest) {
    const n = ambCtx.createBufferSource(), f = ambCtx.createBiquadFilter(), e = ambCtx.createGain();
    n.buffer = AmbMakeWhite(0.035);
    f.type = 'highpass';
    f.frequency.value = 7500;
    e.gain.setValueAtTime(0.055, time);
    e.gain.exponentialRampToValueAtTime(0.001, time + 0.025);
    n.connect(f);
    f.connect(e);
    e.connect(dest);
    n.start(time);
    n.stop(time + 0.04);
  }

  //4-bar chord progression
  //bass = 4 square-wave notes (one per beat)  providing the root/fifth
  //arp  = 4 notes cycled at 16th-note rate (4 reps * 4 notes = 16 hits)
  //lead = sustained sawtooth notes (with vibrato) melody line.
  //cycle: Dm -> F -> Bb -> Am (minor ii–IV–bVII–i feel in D minor)
  const BOSS_PROGRESSION = [
    {
      bass: [NOTE.D2, NOTE.D2, NOTE.D3, NOTE.A2],
      arp: [NOTE.D4, NOTE.F4, NOTE.A4, NOTE.C5],
      lead: [{noteFreq: NOTE.A5, noteDur: BEAT_DUR * 2}, {noteFreq: NOTE.F5, noteDur: BEAT_DUR * 2}]
    },
    {
      bass: [NOTE.F2, NOTE.F2, NOTE.C3, NOTE.A2],
      arp: [NOTE.C4, NOTE.F4, NOTE.A4, NOTE.C5],
      lead: [{noteFreq: NOTE.G5, noteDur: BEAT_DUR * 2}, {noteFreq: NOTE.E5, noteDur: BEAT_DUR * 2}]
    },
    {
      bass: [NOTE.Bb1, NOTE.Bb1, NOTE.F2, NOTE.D2],
      arp: [NOTE.Bb3, NOTE.D4, NOTE.F4, NOTE.Bb4],
      lead: [{noteFreq: NOTE.F5, noteDur: BEAT_DUR * 2}, {noteFreq: NOTE.D5, noteDur: BEAT_DUR * 2}]
    },
    {
      bass: [NOTE.A1, NOTE.A1, NOTE.E2, NOTE.Cs2],
      arp: [NOTE.A3, NOTE.Cs4, NOTE.E4, NOTE.A4],
      lead: [{noteFreq: NOTE.E5, noteDur: BEAT_DUR}, {noteFreq: NOTE.Cs5, noteDur: BEAT_DUR}, {
        noteFreq: NOTE.D5,
        noteDur: BEAT_DUR * 2
      }]
    }
  ];

  //pattern (4/4 bar):
  //kick   = beat 1 and beat 3
  //snare  = beat 2 and beat 4
  //hi-hat = all 8 eighth-note subdivisions
  //bass   = one square note per beat (x4)
  //arp    = 4-note pattern repeated 4 times at 16th note rate ( 16 hits)
  //lead   = consecutive notes from the bar lead array
  function bmScheduleBar(barStart, barNum) {
    if (!bossMusicActive) return;
    const bar = BOSS_PROGRESSION[barNum % 4]; //cycle every 4 bars
    const dest = bossMusicGain;

    //Kick beats 1 and 3 (0 and 2 * BEAT_DUR from bar start)
    BmKick(barStart, dest);
    BmKick(barStart + BEAT_DUR * 2, dest);

    //snare beats 2 and 4
    BmSnare(barStart + BEAT_DUR, dest);
    BmSnare(barStart + BEAT_DUR * 3, dest);

    //hi-hat all 8 eighth notes
    for (let h = 0; h < 8; h++) BmHiHat(barStart + h * EIGHTH_NOTE, dest);

    //bass: one note per beat each lasting 78% of a beat
    bar.bass.forEach((freq, i) => BmNote(barStart + i * BEAT_DUR, freq, 'square', BEAT_DUR * 0.78, 0.3, dest));

    //arpeggio: 4-note motif x4 reps at 16th-note rate
    for (let rep = 0; rep < 4; rep++)
      bar.arp.forEach((freq, i) =>
        BmNote(barStart + (rep * 4 + i) * SIXTEENTH_NOTE, freq, 'square', SIXTEENTH_NOTE * 0.75, 0.1, dest));

    //lead: notes placed consecutively starting from barStart
    let leadTime = barStart;
    bar.lead.forEach(({noteFreq, noteDur}) => {
      BmLead(leadTime, noteFreq, noteDur, dest);
      leadTime += noteDur;
    });

    //schedule the next bar 300 ms before it's due (look-ahead scheduling)
    const nextBarStart = barStart + BEAT_DUR * 4;
    bossMusicTids.push(setTimeout(
      () => bmScheduleBar(nextBarStart, barNum + 1),
      Math.max(50, (nextBarStart - ambCtx.currentTime) * 1000 - 300)
    ));
  }

  //starts the boss music:
  //1) creates a dedicated sub-GainNode (bossMusicGain) that connects to AmbMaster
  //2) fades the boss music in over 1.5s
  //3) simultaneously ducks the master gain (0.75 -> 0.5) so the boss theme
  // sits on top of the ambient drone without volume overload
  function StartBossMusic() {
    if (!ambCtx || !ambMaster || !ambActive)
      return;
    bossMusicActive = true;
    bossMusicGain = ambCtx.createGain();
    bossMusicGain.gain.setValueAtTime(0, ambCtx.currentTime);
    bossMusicGain.gain.linearRampToValueAtTime(0.9, ambCtx.currentTime + 1.5);
    bossMusicGain.connect(ambMaster);
    ambMaster.gain.setValueAtTime(ambMaster.gain.value || 0.75, ambCtx.currentTime);
    ambMaster.gain.linearRampToValueAtTime(0.5, ambCtx.currentTime + 1.5);  //duck ambient
    bmScheduleBar(ambCtx.currentTime + 0.05, 0);                            //start immediately
  }

  //Stops boss music:
  //1) cancels all pending bar-scheduling timeouts
  //2) fades bossMusicGain to 0 over 1.8s
  //3) fades AmbMaster back up to 0.75
  function StopBossMusic() {
    if (!bossMusicActive)
      return;
    bossMusicActive = false;
    bossMusicTids.forEach(t => clearTimeout(t));
    bossMusicTids = [];
    if (bossMusicGain && ambCtx)
      bossMusicGain.gain.linearRampToValueAtTime(0, ambCtx.currentTime + 1.8);
    if (ambMaster && ambCtx && ambActive) {
      ambMaster.gain.setValueAtTime(ambMaster.gain.value || 0.5, ambCtx.currentTime);
      ambMaster.gain.linearRampToValueAtTime(0.75, ambCtx.currentTime + 1.8);
    }
  }

  class Game {
    constructor() {
      this.input = new InputHandler();
      this.background = new Background();
      this.particles = new ParticleSystem();
      this._ResetState();
      this._rafId = null;
    }

    _ResetState() {
      this.player = null;
      this.enemies = [];
      this.boss = null;
      this.bossDefeated = false;
      this.bullets = [];       //player bullets
      this.enemyBullets = [];  //enemy/boss bullets
      this.powerups = [];
      this.running = false;
      this.waveManager = new WaveManager();
      this.particles.list = [];
    }

    //resets state, spawns the player, fires up audio
    Start() {
      this._ResetState();
      this.player = new Player(200, 300);
      this.running = true;
      gTime = 0;
      StartAmbience();
    }

    //advances all subsystems: handles shooting, spawning, collision detection, powerup pickup, particle emission
    Update() {
      if (!this.running) return;
      gTime++;
      this.background.Update();
      this.player.Update(this.input);

      //fires only when left mouse is held and shoot cooldown has expired
      if (this.input.mouse.down && this.player.shootCooldown <= 0) {
        const shots = this.player.Shoot();
        this.bullets.push(...shots);
        AmbPlayGunShot(); //play the gunshot SFX
      }

      //wave/boss management
      if (!this.waveManager.IsBossPhase) {
        const newEnemy = this.waveManager.Update(this.enemies.length);
        if (newEnemy) this.enemies.push(newEnemy);
      }
      //spawn boss once the boss phase begins and boss doesn't already exist
      if (this.waveManager.IsBossPhase && !this.boss && !this.bossDefeated) {
        this.boss = new Boss(CLIENT_WIDTH * 0.78, CLIENT_HEIGHT * 0.5, this.enemies);
        StartBossMusic();
      }

      //player bullets vs. enemies
      this.bullets = this.bullets.filter(bullet => {
        bullet.Update();
        if (!bullet.active) return false; //expired or out of bounds

        //cCheck against every live enemy
        for (const enemy of this.enemies) {
          if (bullet.Hits(enemy)) {
            this.particles.Hit(bullet.x, bullet.y, '#7ff9ff');
            if (enemy.TakeDamage(bullet.damage) === 'dead') this._KillEnemy(enemy);
            return false; //bullet consumed on first hit (no piercing)
          }
        }
        //check against the boss
        if (this.boss && bullet.Hits(this.boss)) {
          this.particles.Hit(bullet.x, bullet.y, '#7ff9ff');
          if (this.boss.TakeDamage(bullet.damage) === 'dead') this._KillBoss();
          return false;
        }
        return true; //bullet still active
      });

      //enemy update + melee contact
      this.enemies.forEach(enemy => {
        const shots = enemy.Update(this.player, this.waveManager.WaveNum);
        if (shots)
          this.enemyBullets.push(...shots);
        //only fires when player is vulnerable (iFrames == 0)
        if (this.player.iFrames <= 0 && enemy.Touching(this.player))
          this._DamagePlayer(enemy.ContactDamage);
      });

      //boss update
      if (this.boss) {
        this.boss.Update(this.player).forEach(event => {
          if (event.isMelee) {
            //slam apply directly if player not invincible
            if (this.player.iFrames <= 0)
              this._DamagePlayer(event.damage);
          } else {
            //add projectile to enemy bullet pool
            this.enemyBullets.push(event);
          }
        });
      }

      //enemy bullets vs. player
      this.enemyBullets = this.enemyBullets.filter(bullet => {
        bullet.Update();
        if (!bullet.active)
          return false;

        if (this.player.iFrames <= 0 && bullet.Hits(this.player)) {
          this._DamagePlayer(bullet.damage);
          return false;
        }
        return true;
      });

      //powerup pickup
      this.powerups = this.powerups.filter(powerup => {
        powerup.Update();
        if (!powerup.active)
          return false;
        if (powerup.CollidesWith(this.player)) {
          this.player.ApplyPowerup(powerup.type);
          //hit particle burst in the powerup color to confirm collection
          this.particles.Hit(powerup.x, powerup.y, powerup.type === 'shield' ? '#40aaff' : '#40ff80');
          return false; //consumed
        }
        return true;
      });

      this.particles.Update();
      UI.Update(this.player, this.waveManager.WaveNum, this.waveManager.IsBossPhase);
    }

    //clears the canvas, draws every layer in Z-order
    Draw() {
      ctx.clearRect(0, 0, CLIENT_WIDTH, CLIENT_HEIGHT);
      this.background.Draw();

      if (!this.player) {
        //just show the overlay (title or game-over screen)
        UI.DrawOverlay();
        return;
      }

      //dashed aim line (player to mouse cursor)
      ctx.save();
      ctx.strokeStyle = 'rgba(0,200,255,0.09)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 8]); //6px dash 8px gap
      ctx.beginPath();
      ctx.moveTo(this.player.x, this.player.y);
      ctx.lineTo(this.input.mouse.x, this.input.mouse.y);
      ctx.stroke();
      ctx.setLineDash([]); //reset to solid
      ctx.restore();

      //world objects z-ordered back to front
      this.enemies.forEach(enemy => enemy.Draw());
      if (this.boss) this.boss.Draw();
      this.enemyBullets.forEach(bullet => bullet.Draw());
      this.bullets.forEach(bullet => bullet.Draw());
      this.powerups.forEach(powerup => powerup.Draw());
      this.player.Draw();
      this.particles.Draw();

      //crosshair reticule centred on the mouse cursor
      //4 line segments with a 4px gap around the center give a standard "+" reticule
      const mouseX = this.input.mouse.x, mouseY = this.input.mouse.y, cs = 12;
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = 'rgba(0,240,255,0.8)';
      ctx.lineWidth = 1.5;

      //arms
      ctx.beginPath();
      ctx.moveTo(mouseX - cs, mouseY);
      ctx.lineTo(mouseX - 4, mouseY);
      ctx.moveTo(mouseX + 4, mouseY);
      ctx.lineTo(mouseX + cs, mouseY);
      ctx.moveTo(mouseX, mouseY - cs);
      ctx.lineTo(mouseX, mouseY - 4);
      ctx.moveTo(mouseX, mouseY + 4);
      ctx.lineTo(mouseX, mouseY + cs);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,240,255,0.4)';
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, 8, 0, 6.28);
      ctx.stroke();
      ctx.restore();

      //HUD layers
      this.waveManager.DrawHUD(); //wave transition banner (if active)
      UI.DrawHUD();               //health, score, wave counter
      UI.DrawOverlay();           //title/game-over overlay (if visible)
    }

    //main game loop using requestAnimationFrame
    //arrow function ensures "this" refers to the Game instance rather than the global object
    // The RAF handle is stored so it can be cancelled by destroy()
    Loop() {
      this.Update();
      this.Draw();
      this._rafId = requestAnimationFrame(() => this.Loop());
    }

    //damage handler fires particle effect and checks for game-over
    _DamagePlayer(damage) {
      const result = this.player.TakeDamage(damage);
      //blue spark for shield absorb
      //orange for normal hit
      this.particles.Hit(this.player.x, this.player.y,
        result === 'shield' ? '#40aaff' : '#f64');
      if (result === 'dead') this._GameOver();
    }

    //called when an enemy health reaches 0
    // Score multiplied by WaveNum so later waves award more per kill.
    //notifies the WaveManager (increments kills counter)
    //attempts a random powerup drop
    //removes the enemy from the live array with splice (avoids iteration issues)
    //updates the boss live reference to the enemies array so minion spawns are reflected in internal state
    _KillEnemy(enemy) {
      this.waveManager.OnKill();
      this.particles.Death(enemy.x, enemy.y, enemy.type);
      var drop = enemy.TryDrop();
      if (drop) this.powerups.push(drop);
      const idx = this.enemies.indexOf(enemy);
      if (idx !== -1) this.enemies.splice(idx, 1);
      // Keep the boss's live reference in sync after a minion is removed.
      if (this.boss) this.boss.enemiesRef = this.enemies;
    }

    //boss kill sequence:
    //1) +1500 score bonus
    //2) massive particle explosion
    //3) stop boss music
    //4) after 900ms: null out the boss reference (lets the explosion play)
    //5) after 3200ms: stop running, stop ambience, then after 600 ms show the VICTORY overlay
    _KillBoss() {
      this.bossDefeated = true;
      this.particles.BossDeath(this.boss.x, this.boss.y);
      StopBossMusic();
      setTimeout(() => {
        this.boss = null;
      }, 900);
      setTimeout(() => {
        this.running = false;
        StopAmbience();
        setTimeout(() => UI.ShowOverlay('VICTORY!', 'The Leviathan has been defeated!'), 600);
      }, 3200);
    }

    //game over sequence: stop game, stop audio, show overlay after 800ms
    _GameOver() {
      if (!this.running) return; //guard against double-trigger
      this.running = false;
      StopAmbience();
      setTimeout(() =>
          UI.ShowOverlay('GAME OVER', 'The ocean claimed you.'),
        800
      );
    }

    //cancels the RAF loop, removes all input listeners, and stops audio
    //must be called when closing the game popup to prevent memory leaks and orphaned audio nodes
    destroy() {
      this.running = false;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this.input.destroy();
      StopAmbience();
    }
  }

  //everything below this point runs once when StartGame(canvas) is called
  const game = new Game();

  const _onKeyDown = e => {
    if (e.key === 'Enter' && overlayState.visible) {
      UI.HideOverlay();
      game.Start();
    }
    //'B' skips the regular waves and jumps straight to the boss
    if ((e.key === 'b' || e.key === 'B') && game.running && !game.waveManager.IsBossPhase) {
      game.enemies = [];                //clear all live enemies
      game.waveManager.phase = 'boss';  //advance wave state machine to boss phase
    }
  };
  document.addEventListener('keydown', _onKeyDown);

  game.Loop();

  //returns a minimal controller so the host can tear everything down cleanly
  return {
    destroy() {
      game.destroy();
      document.removeEventListener('keydown', _onKeyDown);
    }
  };
}
