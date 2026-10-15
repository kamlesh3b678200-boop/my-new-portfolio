(() => {
  const TOTAL_FRAMES = 240;
  const LERP_FACTOR = 0.12;

  const canvas = document.getElementById('frame-canvas');
  const loaderBar = document.getElementById('loader-bar');
  const loaderContainer = document.getElementById('loader-container');
  const navbar = document.getElementById('navbar');
  const menuToggle = document.getElementById('menu-toggle');
  const navLinks = document.getElementById('nav-links');
  const themeToggle = document.getElementById('theme-toggle');
  const toggleLabel = document.getElementById('toggle-label');

  // Theme state: default is texture background with transparent subject cutout
  let isTextureMode = true;

  // Frame image cache: indices 1 through 240
  const frames = new Array(TOTAL_FRAMES + 1);
  let loadedCount = 0;

  // Scroll and animation states
  let targetProgress = 0;
  let currentProgress = 0;
  let lastRenderedFrame = -1;
  let initialFrameLoaded = false;
  let lenisInstance = null;

  // WebGL references
  let gl = null;
  let glProgram = null;
  let glTexture = null;
  let glPosBuffer = null;
  let glTexBuffer = null;
  let glUniforms = {};
  let ctx2d = null;

  // Format frame URL: frames/frame_000001.png
  function getFrameSrc(index) {
    const padded = String(index).padStart(6, '0');
    return `frames/frame_${padded}.png`;
  }

  // Initialize WebGL context with transparent alpha for seamless cutout
  function initWebGL() {
    try {
      gl = canvas.getContext('webgl', { 
        alpha: true, 
        premultipliedAlpha: true, 
        depth: false, 
        antialias: false, 
        preserveDrawingBuffer: false 
      }) || canvas.getContext('experimental-webgl', { 
        alpha: true, 
        premultipliedAlpha: true 
      });
      
      if (!gl) {
        console.warn('WebGL not supported, falling back to 2D Canvas');
        ctx2d = canvas.getContext('2d', { alpha: true });
        return;
      }

      const vsSource = `
        attribute vec2 a_pos;
        attribute vec2 a_tex;
        varying vec2 v_tex;
        void main() {
          gl_Position = vec4(a_pos, 0.0, 1.0);
          v_tex = a_tex;
        }
      `;

      const fsSource = `
        precision mediump float;
        uniform sampler2D u_image;
        uniform vec3 u_keyColor;
        uniform float u_threshold;
        uniform float u_smoothness;
        uniform int u_mode;
        varying vec2 v_tex;

        void main() {
          vec4 col = texture2D(u_image, v_tex);
          if (u_mode == 1) {
            float d = distance(col.rgb, u_keyColor);
            float a = clamp((d - u_threshold) / u_smoothness, 0.0, 1.0);
            gl_FragColor = vec4(col.rgb * a, a);
          } else {
            gl_FragColor = col;
          }
        }
      `;

      function createShader(type, src) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.error(gl.getShaderInfoLog(shader));
          gl.deleteShader(shader);
          return null;
        }
        return shader;
      }

      const vs = createShader(gl.VERTEX_SHADER, vsSource);
      const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
      glProgram = gl.createProgram();
      gl.attachShader(glProgram, vs);
      gl.attachShader(glProgram, fs);
      gl.linkProgram(glProgram);

      if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(glProgram));
        return;
      }

      gl.useProgram(glProgram);

      // Attribute buffers
      const aPosLoc = gl.getAttribLocation(glProgram, 'a_pos');
      const aTexLoc = gl.getAttribLocation(glProgram, 'a_tex');

      glPosBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glPosBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1
      ]), gl.STATIC_DRAW);

      glTexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glTexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        0, 1,
        1, 0,
        1, 1
      ]), gl.STATIC_DRAW);

      gl.enableVertexAttribArray(aPosLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, glPosBuffer);
      gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

      gl.enableVertexAttribArray(aTexLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, glTexBuffer);
      gl.vertexAttribPointer(aTexLoc, 2, gl.FLOAT, false, 0, 0);

      // Texture setup
      glTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      // Uniform locations
      glUniforms = {
        image: gl.getUniformLocation(glProgram, 'u_image'),
        keyColor: gl.getUniformLocation(glProgram, 'u_keyColor'),
        threshold: gl.getUniformLocation(glProgram, 'u_threshold'),
        smoothness: gl.getUniformLocation(glProgram, 'u_smoothness'),
        mode: gl.getUniformLocation(glProgram, 'u_mode')
      };

    } catch (e) {
      console.warn('WebGL init error, falling back to 2D:', e);
      gl = null;
      ctx2d = canvas.getContext('2d', { alpha: true });
    }
  }

  // Resize canvas with devicePixelRatio
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = window.innerWidth;
    const height = window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    renderFrame(getCurrentFrameIndex(), true);
  }

  // Draw frame with WebGL or 2D fallback
  function drawFrame(img) {
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    if (gl && glProgram) {
      gl.useProgram(glProgram);

      // Clear full canvas with transparency
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Bind texture
      gl.bindTexture(gl.TEXTURE_2D, glTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

      // Chroma key uniforms
      gl.uniform3f(glUniforms.keyColor, 252/255, 222/255, 16/255);
      gl.uniform1i(glUniforms.mode, isTextureMode ? 1 : 0);
      gl.uniform1f(glUniforms.threshold, 0.18);
      gl.uniform1f(glUniforms.smoothness, 0.12);

      // In WebGL, viewport y starts from bottom-left
      const glY = ch - (dy + dh);
      gl.viewport(Math.round(dx), Math.round(glY), Math.round(dw), Math.round(dh));
      gl.drawArrays(gl.TRIANGLES, 0, 6);

    } else if (ctx2d) {
      ctx2d.clearRect(0, 0, cw, ch);
      if (!isTextureMode) {
        ctx2d.fillStyle = '#fcdd12';
        ctx2d.fillRect(0, 0, cw, ch);
      }
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.imageSmoothingQuality = 'high';
      ctx2d.drawImage(img, dx, dy, dw, dh);
    }
  }

  // Get exact or closest loaded frame
  function getClosestAvailableFrame(index) {
    if (frames[index] && frames[index].isReady) {
      return frames[index];
    }
    for (let offset = 1; offset < TOTAL_FRAMES; offset++) {
      const prev = index - offset;
      if (prev >= 1 && frames[prev] && frames[prev].isReady) return frames[prev];
      const next = index + offset;
      if (next <= TOTAL_FRAMES && frames[next] && frames[next].isReady) return frames[next];
    }
    return null;
  }

  function renderFrame(index, force = false) {
    if (index === lastRenderedFrame && !force) return;
    const img = getClosestAvailableFrame(index);
    if (img) {
      drawFrame(img);
      lastRenderedFrame = index;
    }
  }

  function getCurrentFrameIndex() {
    return Math.min(TOTAL_FRAMES, Math.max(1, Math.round(1 + currentProgress * (TOTAL_FRAMES - 1))));
  }

  function updateScrollProgress() {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll > 0) {
      targetProgress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
    } else {
      targetProgress = 0;
    }

    if (window.scrollY > 40) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }

    updateActiveNav();
  }

  // 60-120fps RAF loop with linear interpolation
  function animationLoop() {
    const diff = targetProgress - currentProgress;

    if (Math.abs(diff) > 0.00005) {
      currentProgress += diff * LERP_FACTOR;
    } else {
      currentProgress = targetProgress;
    }

    const frameToRender = getCurrentFrameIndex();
    renderFrame(frameToRender);

    requestAnimationFrame(animationLoop);
  }

  // Single frame loader
  function loadFrame(index) {
    return new Promise((resolve) => {
      if (frames[index]) {
        resolve(frames[index]);
        return;
      }

      const img = new Image();
      img.decoding = 'async';
      img.src = getFrameSrc(index);

      img.onload = () => {
        img.isReady = true;
        frames[index] = img;
        loadedCount++;

        if (!initialFrameLoaded) {
          initialFrameLoaded = true;
          renderFrame(getCurrentFrameIndex(), true);
        }

        if (loaderBar) {
          const percent = Math.round((loadedCount / TOTAL_FRAMES) * 100);
          loaderBar.style.width = `${percent}%`;
          if (loadedCount >= TOTAL_FRAMES) {
            setTimeout(() => {
              if (loaderContainer) loaderContainer.classList.add('hidden');
            }, 300);
          }
        }

        resolve(img);
      };

      img.onerror = () => {
        console.warn(`Could not load frame ${index}`);
        resolve(null);
      };
    });
  }

  // Progressive preloader
  async function preloadAllFrames() {
    await loadFrame(1);

    const keyframes = [];
    for (let i = 6; i <= TOTAL_FRAMES; i += 6) {
      keyframes.push(i);
    }
    await Promise.all(keyframes.map(loadFrame));

    const remaining = [];
    for (let i = 2; i <= TOTAL_FRAMES; i++) {
      if (!frames[i]) remaining.push(i);
    }

    const BATCH_SIZE = 8;
    for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
      const batch = remaining.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(loadFrame));
    }
  }

  // Lenis smooth scroll
  function setupSmoothScroll() {
    if (typeof Lenis !== 'undefined') {
      lenisInstance = new Lenis({
        duration: 1.0,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        orientation: 'vertical',
        gestureOrientation: 'vertical',
        smoothWheel: true,
        wheelMultiplier: 1.0,
        touchMultiplier: 1.6,
      });

      function raf(time) {
        lenisInstance.raf(time);
        requestAnimationFrame(raf);
      }
      requestAnimationFrame(raf);

      lenisInstance.on('scroll', (e) => {
        if (typeof e.progress === 'number') {
          targetProgress = Math.min(1, Math.max(0, e.progress));
        } else {
          updateScrollProgress();
        }
      });
    }

    window.addEventListener('scroll', updateScrollProgress, { passive: true });
  }

  // Update active nav link based on scroll position
  const sectionIds = ['hero', 'about', 'skills', 'projects', 'contact'];
  function updateActiveNav() {
    const scrollPos = window.scrollY + 180;
    let currentSection = 'hero';
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el && el.offsetTop <= scrollPos) {
        currentSection = id;
      }
    }
    if (navLinks) {
      navLinks.querySelectorAll('.nav-link').forEach(link => {
        const href = link.getAttribute('href');
        if (href === `#${currentSection}`) {
          link.classList.add('active');
        } else {
          link.classList.remove('active');
        }
      });
    }
  }

  // UI Event listeners
  function setupUIListeners() {
    // Mobile navigation toggle
    if (menuToggle && navLinks) {
      menuToggle.addEventListener('click', () => {
        navLinks.classList.toggle('open');
      });

      navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
          navLinks.classList.remove('open');
        });
      });
    }

    // Smooth scroll for all internal anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', (e) => {
        const href = anchor.getAttribute('href');
        if (href === '#' || !href) return;
        const target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          if (lenisInstance) {
            lenisInstance.scrollTo(target, { offset: -70, duration: 1.2 });
          } else {
            target.scrollIntoView({ behavior: 'smooth' });
          }
        }
      });
    });

    // Copy email button
    const copyEmailBtn = document.getElementById('copy-email-btn');
    if (copyEmailBtn) {
      copyEmailBtn.addEventListener('click', () => {
        const email = copyEmailBtn.getAttribute('data-email');
        if (navigator.clipboard && email) {
          navigator.clipboard.writeText(email).then(() => {
            const originalText = copyEmailBtn.textContent;
            copyEmailBtn.textContent = 'Copied!';
            copyEmailBtn.style.color = '#38bdf8';
            setTimeout(() => {
              copyEmailBtn.textContent = originalText;
              copyEmailBtn.style.color = '';
            }, 2000);
          }).catch(() => {
            // Fallback for older browsers
            prompt('Copy email:', email);
          });
        }
      });
    }

    // Theme toggle button
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        isTextureMode = !isTextureMode;
        document.body.classList.toggle('theme-yellow', !isTextureMode);
        
        if (toggleLabel) {
          toggleLabel.textContent = isTextureMode ? 'Textured Mode' : 'Studio Yellow';
        }
        const icon = themeToggle.querySelector('.toggle-icon');
        if (icon) {
          icon.textContent = isTextureMode ? '🎨' : '☀️';
        }

        renderFrame(getCurrentFrameIndex(), true);
      });
    }
  }

  function init() {
    initWebGL();
    updateScrollProgress();
    currentProgress = targetProgress;

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    setupSmoothScroll();
    setupUIListeners();
    requestAnimationFrame(animationLoop);
    preloadAllFrames();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
