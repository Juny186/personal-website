/* 合成大表情 —— Matter.js 物理合成小游戏 */
(function () {
  'use strict';

  var W = 360;                 // 逻辑世界宽度（固定），高度按舞台比例动态计算
  var H = 600;
  var DROP_MAX = 4;            // 可投放的最大等级
  var DROP_Y = 52;             // 待投球中心高度
  var DANGER_Y = 92;           // 警戒线
  var DANGER_MS = 1500;        // 越线持续多久判负
  var COOLDOWN = 420;          // 投放冷却

  var TIERS = [
    { e: '😴', r: 15, c: '#c5b3e6', name: '睡' },
    { e: '🙂', r: 20, c: '#ffe082', name: '微' },
    { e: '😊', r: 25, c: '#ffd54f', name: '笑' },
    { e: '😄', r: 30, c: '#ffca28', name: '哈' },
    { e: '🤣', r: 36, c: '#ffb300', name: '滚' },
    { e: '🤩', r: 42, c: '#ffa000', name: '闪' },
    { e: '🥳', r: 49, c: '#ff8f00', name: '嗨' },
    { e: '🤯', r: 56, c: '#ff7043', name: '炸' },
    { e: '👑', r: 64, c: '#ec407a', name: '王' },
    { e: '🐉', r: 73, c: '#26a69a', name: '龙' },
    { e: '🪐', r: 82, c: '#7e57c2', name: '宙' }
  ];
  var DROP_WEIGHTS = [30, 27, 22, 13, 8];

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var stage = canvas.parentElement;
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var nextEmoji = document.getElementById('nextEmoji');
  var overlay = document.getElementById('overlay');
  var startOverlay = document.getElementById('startOverlay');
  var finalScore = document.getElementById('finalScore');
  var finalBest = document.getElementById('finalBest');
  var soundIcon = document.getElementById('soundIcon');

  var Engine = Matter.Engine, Composite = Matter.Composite, Bodies = Matter.Bodies,
      Body = Matter.Body, Events = Matter.Events;

  var engine, world, balls, walls = [];
  var state = 'ready';
  var score = 0, best = +(localStorage.getItem('emojiMergeBest') || 0);
  var soundOn = localStorage.getItem('emojiMergeSound') !== '0';
  var current = null, nextTier = 0, aimX = W / 2;
  var canDrop = false;
  var dangerMs = 0;
  var particles = [], floats = [], pops = new Map();
  var shake = 0, flashTier = -1, flashT = 0;
  var scale = 1, dpr = 1, lastT = 0;
  var removed = new Set();
  var audioCtx = null;

  bestEl.textContent = best;
  soundIcon.textContent = soundOn ? '🔊' : '🔇';

  /* ---------------- 图鉴 ---------------- */
  (function buildLegend() {
    var legend = document.getElementById('legend');
    var html = '';
    for (var i = 0; i < TIERS.length; i++) {
      var fs = 13 + i * 1.35;
      html += '<div class="cell"><span class="e" style="font-size:' + fs + 'px">' +
              TIERS[i].e + '</span><span class="n">' + TIERS[i].name + '</span></div>';
    }
    legend.innerHTML = html;
  })();

  /* ---------------- 音效 ---------------- */
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function beep(freq, dur, type, vol) {
    if (!soundOn || !audioCtx) return;
    var t0 = audioCtx.currentTime;
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.18, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  function sndPop(tier) {
    beep(300 + tier * 55, 0.16, 'triangle', 0.16);
    if (tier >= 6) beep(160 + tier * 30, 0.3, 'sine', 0.14);
  }
  function sndDrop() { beep(240, 0.07, 'sine', 0.08); }
  function sndOver() {
    beep(330, 0.25, 'sawtooth', 0.12);
    setTimeout(function () { beep(220, 0.35, 'sawtooth', 0.12); }, 180);
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    var rect = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    scale = rect.width / W;
    H = rect.height / scale;
    if (walls.length) {
      Body.setPosition(walls[0], { x: -40, y: H / 2 });
      Body.setPosition(walls[1], { x: W + 40, y: H / 2 });
      Body.setPosition(walls[2], { x: W / 2, y: H + 40 });
    }
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 200); });

  /* ---------------- 物理世界 ---------------- */
  function makeWalls() {
    var opt = { isStatic: true, restitution: 0.1, friction: 0.2 };
    return [
      Bodies.rectangle(-40, H / 2, 80, H * 3, opt),
      Bodies.rectangle(W + 40, H / 2, 80, H * 3, opt),
      Bodies.rectangle(W / 2, H + 40, W + 240, 80, opt)
    ];
  }

  function makeBall(x, y, tier, held) {
    var t = TIERS[tier];
    var body = Bodies.circle(x, y, t.r, {
      label: 'ball',
      restitution: 0.22,
      friction: 0.06,
      frictionAir: 0.006,
      slop: 0.02,
      isStatic: !!held
    });
    body.plugin = { tier: tier };
    if (held) body.plugin.held = true;
    pops.set(body.id, 0.22);
    return body;
  }

  function randTier() {
    var r = Math.random() * 100, acc = 0;
    for (var i = 0; i < DROP_WEIGHTS.length; i++) {
      acc += DROP_WEIGHTS[i];
      if (r < acc) return i;
    }
    return 0;
  }

  function spawnHeld() {
    var r0 = TIERS[nextTier].r;
    current = makeBall(clamp(aimX, r0, W - r0), DROP_Y, nextTier, true);
    nextTier = randTier();
    nextEmoji.textContent = TIERS[nextTier].e;
    Composite.add(world, current);
    canDrop = true;
  }

  function dropBall() {
    if (!canDrop || !current || state !== 'playing') return;
    canDrop = false;
    current.plugin.held = false;
    Body.setStatic(current, false);
    Body.setVelocity(current, { x: 0, y: 0 });
    sndDrop();
    current = null;
    setTimeout(function () {
      if (state === 'playing' && !current) spawnHeld();
    }, COOLDOWN);
  }

  /* ---------------- 合成 ---------------- */
  function onCollision(ev) {
    var pairs = ev.pairs;
    for (var i = 0; i < pairs.length; i++) {
      var a = pairs[i].bodyA, b = pairs[i].bodyB;
      if (a.label !== 'ball' || b.label !== 'ball') continue;
      if (removed.has(a.id) || removed.has(b.id)) continue;
      var ta = a.plugin.tier, tb = b.plugin.tier;
      if (ta !== tb) continue;
      // 手里的球不参与合成
      if (a.plugin.held || b.plugin.held) continue;
      mergePair(a, b, ta);
    }
  }

  function mergePair(a, b, tier) {
    removed.add(a.id);
    removed.add(b.id);
    pops.delete(a.id);
    pops.delete(b.id);
    var mx = (a.position.x + b.position.x) / 2;
    var my = (a.position.y + b.position.y) / 2;
    Composite.remove(world, a);
    Composite.remove(world, b);

    burst(mx, my, TIERS[tier].c, tier);

    if (tier + 1 >= TIERS.length) {
      // 两个终极合成 → 消失 + 大奖
      addScore(200, mx, my);
      bigFlash(tier);
      shake = Math.max(shake, 10);
      sndPop(tier + 2);
      return;
    }
    var nb = makeBall(mx, my, tier + 1, false);
    // 保留双方一点动量
    var vx = ((a.velocity.x + b.velocity.x) / 2) * 0.4;
    var vy = ((a.velocity.y + b.velocity.y) / 2) * 0.4;
    Composite.add(world, nb);
    Body.setVelocity(nb, { x: vx, y: vy });
    var gain = (tier + 2) * (tier + 3);
    addScore(gain, mx, my);
    floats.push({ x: mx, y: my - TIERS[tier + 1].r, text: '+' + gain, life: 0.9 });
    if (tier + 1 >= 6) shake = Math.max(shake, 3 + tier * 0.7);
    if (tier + 1 >= 8) bigFlash(tier + 1);
    sndPop(tier + 1);
  }

  function burst(x, y, color, tier) {
    var n = 8 + tier * 3;
    for (var i = 0; i < n; i++) {
      var ang = Math.random() * Math.PI * 2;
      var sp = 1.2 + Math.random() * (1.6 + tier * 0.25);
      particles.push({
        x: x, y: y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 1,
        r: 2 + Math.random() * 3,
        color: color, life: 0.55 + Math.random() * 0.3
      });
    }
  }

  function bigFlash(tier) {
    flashTier = tier;
    flashT = 0.35;
  }

  /* ---------------- 分数 ---------------- */
  function addScore(n) {
    score += n;
    scoreEl.textContent = score;
    scoreEl.classList.remove('pop');
    void scoreEl.offsetWidth;
    scoreEl.classList.add('pop');
    if (score > best) {
      best = score;
      bestEl.textContent = best;
    }
  }

  /* ---------------- 游戏流程 ---------------- */
  function initWorld() {
    engine = Engine.create();
    engine.positionIterations = 8;
    engine.velocityIterations = 6;
    world = engine.world;
    world.gravity.y = 1.15;
    walls = makeWalls();
    Composite.add(world, walls);
    Events.on(engine, 'collisionStart', onCollision);
    balls = [];
    particles = [];
    floats = [];
    pops = new Map();
    removed = new Set();
    score = 0;
    dangerMs = 0;
    shake = 0;
    flashT = 0;
    current = null;
    scoreEl.textContent = '0';
  }

  function startGame() {
    initWorld();
    nextTier = randTier();
    spawnHeld();
    state = 'playing';
    overlay.classList.add('hidden');
    startOverlay.classList.add('hidden');
    ensureAudio();
  }

  function gameOver() {
    state = 'over';
    if (score > best) best = score;
    localStorage.setItem('emojiMergeBest', String(best));
    bestEl.textContent = best;
    finalScore.textContent = score;
    finalBest.textContent = best;
    overlay.classList.remove('hidden');
    sndOver();
  }

  /* ---------------- 输入 ---------------- */
  function pointerX(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    return clamp((cx - rect.left) / rect.width * W, TIERS[0].r + 2, W - TIERS[0].r - 2);
  }
  function aim(e) {
    aimX = pointerX(e);
    if (current && canDrop) {
      var t = TIERS[current.plugin.tier];
      Body.setPosition(current, { x: clamp(aimX, t.r, W - t.r), y: DROP_Y });
    }
  }
  canvas.addEventListener('mousemove', aim);
  canvas.addEventListener('mousedown', function (e) { aim(e); });
  canvas.addEventListener('mouseup', dropBall);
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); aim(e); }, { passive: false });
  canvas.addEventListener('touchmove', function (e) { e.preventDefault(); aim(e); }, { passive: false });
  canvas.addEventListener('touchend', function (e) { e.preventDefault(); dropBall(); }, { passive: false });

  document.getElementById('startBtn').addEventListener('click', startGame);
  document.getElementById('againBtn').addEventListener('click', startGame);
  document.getElementById('restartBtn').addEventListener('click', function () {
    if (state === 'playing' || state === 'over') startGame();
  });
  document.getElementById('soundBtn').addEventListener('click', function () {
    soundOn = !soundOn;
    localStorage.setItem('emojiMergeSound', soundOn ? '1' : '0');
    soundIcon.textContent = soundOn ? '🔊' : '🔇';
    ensureAudio();
    beep(440, 0.1, 'sine', 0.12);
  });

  /* ---------------- 结束判定 ---------------- */
  function checkDanger(dt) {
    var bad = false;
    if (state !== 'playing') return;
    var all = Composite.allBodies(world);
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b.label !== 'ball' || b.plugin.held) continue;
      var r = TIERS[b.plugin.tier].r;
      var speed = Math.abs(b.velocity.x) + Math.abs(b.velocity.y);
      if (b.position.y - r < DANGER_Y && speed < 2.2) { bad = true; break; }
    }
    if (bad) {
      dangerMs += dt;
      if (dangerMs >= DANGER_MS) gameOver();
    } else {
      dangerMs = Math.max(0, dangerMs - dt * 2);
    }
  }

  /* ---------------- 渲染 ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function drawDangerLine() {
    var danger = dangerMs > 200;
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = danger
      ? 'rgba(230,40,30,' + (0.55 + 0.35 * Math.sin(performance.now() / 90)) + ')'
      : 'rgba(220,130,40,0.35)';
    ctx.beginPath();
    ctx.moveTo(8, DANGER_Y);
    ctx.lineTo(W - 8, DANGER_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawGhost() {
    if (state !== 'playing' || !canDrop || !current) return;
    var t = TIERS[current.plugin.tier];
    var x = clamp(aimX, t.r, W - t.r);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(200,110,20,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, DROP_Y + t.r + 4);
    ctx.lineTo(x, H - 6);
    ctx.stroke();
    drawBallShape(x, DROP_Y, t.r, t.c, t.e, 0.82, 0.85);
    ctx.restore();
  }

  function drawBallShape(x, y, r, color, emoji, alpha, grow) {
    grow = grow == null ? 1 : grow;
    alpha = alpha == null ? 1 : alpha;
    var rr = r * grow;
    ctx.save();
    ctx.globalAlpha = alpha;
    // 底盘
    var g = ctx.createRadialGradient(x - rr * 0.3, y - rr * 0.35, rr * 0.1, x, y, rr);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.45, shade(color, 18));
    g.addColorStop(1, shade(color, -22));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, rr * 0.05);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.stroke();
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.ellipse(x - rr * 0.32, y - rr * 0.4, rr * 0.22, rr * 0.13, -0.6, 0, Math.PI * 2);
    ctx.fill();
    // emoji
    ctx.font = '600 ' + Math.round(rr * 1.5) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, x, y + rr * 0.06);
    ctx.restore();
  }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = clamp((n >> 16) + amt, 0, 255);
    var g = clamp(((n >> 8) & 255) + amt, 0, 255);
    var b = clamp((n & 255) + amt, 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function render(dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(scale, scale);

    if (shake > 0.2) {
      var sx = (Math.random() - 0.5) * shake;
      var sy = (Math.random() - 0.5) * shake;
      ctx.translate(sx, sy);
      shake *= Math.pow(0.001, dt / 1000 * 4);
    }

    drawDangerLine();
    drawGhost();

    // 球
    var all = Composite.allBodies(world);
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b.label !== 'ball') continue;
      var t = TIERS[b.plugin.tier];
      var grow = 1;
      if (pops.has(b.id)) {
        var p = pops.get(b.id) - dt / 1000;
        if (p <= 0) pops.delete(b.id);
        else {
          pops.set(b.id, p);
          grow = 1 + 0.28 * (p / 0.22);
        }
      }
      drawBallShape(b.position.x, b.position.y, t.r, t.c, t.e, b.plugin.held ? 0.95 : 1, grow);
    }

    // 粒子
    for (var k = particles.length - 1; k >= 0; k--) {
      var pa = particles[k];
      pa.life -= dt / 1000;
      if (pa.life <= 0) { particles.splice(k, 1); continue; }
      pa.x += pa.vx;
      pa.y += pa.vy;
      pa.vy += 0.12;
      pa.vx *= 0.98;
      ctx.globalAlpha = clamp(pa.life * 1.8, 0, 1);
      ctx.fillStyle = pa.color;
      ctx.beginPath();
      ctx.arc(pa.x, pa.y, pa.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 飘分
    for (var j = floats.length - 1; j >= 0; j--) {
      var f = floats[j];
      f.life -= dt / 1000;
      if (f.life <= 0) { floats.splice(j, 1); continue; }
      f.y -= 0.5;
      ctx.globalAlpha = clamp(f.life * 1.6, 0, 1);
      ctx.font = '800 17px -apple-system,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8630a';
      ctx.fillText(f.text, f.x, f.y);
      ctx.globalAlpha = 1;
    }

    // 终极闪光
    if (flashT > 0) {
      flashT -= dt / 1000;
      var a = clamp(flashT / 0.35, 0, 1) * 0.5;
      ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }

    ctx.restore();
  }

  /* ---------------- 主循环 ---------------- */
  function loop(now) {
    var dt = Math.min(now - lastT || 16, 33);
    lastT = now;
    if (state === 'playing') {
      Engine.update(engine, 1000 / 60);
      checkDanger(dt);
    }
    render(dt);
    requestAnimationFrame(loop);
  }

  resize();
  initWorld();
  state = 'ready';
  requestAnimationFrame(loop);
})();
