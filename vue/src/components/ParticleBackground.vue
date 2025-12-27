<template>
  <canvas ref="canvasRef" class="particle-canvas"></canvas>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";

const canvasRef = ref(null);
let animationId = null;
let particles = [];

class Particle {
  constructor(canvas) {
    this.canvas = canvas;
    this.reset();
  }

  reset() {
    this.x = Math.random() * this.canvas.width;
    this.y = Math.random() * this.canvas.height;
    this.size = Math.random() * 2 + 0.5;
    this.speedX = (Math.random() - 0.5) * 0.3;
    this.speedY = (Math.random() - 0.5) * 0.3;
    this.opacity = Math.random() * 0.5 + 0.2;
    this.hue = Math.random() * 60 + 240; // 紫蓝色调
  }

  update() {
    this.x += this.speedX;
    this.y += this.speedY;

    // 边界处理
    if (this.x < 0 || this.x > this.canvas.width) this.speedX *= -1;
    if (this.y < 0 || this.y > this.canvas.height) this.speedY *= -1;

    // 缓慢变化透明度
    this.opacity += (Math.random() - 0.5) * 0.01;
    this.opacity = Math.max(0.1, Math.min(0.7, this.opacity));
  }

  draw(ctx) {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${this.hue}, 70%, 60%, ${this.opacity})`;
    ctx.fill();

    // 发光效果
    ctx.shadowBlur = 10;
    ctx.shadowColor = `hsla(${this.hue}, 70%, 60%, 0.5)`;
  }
}

const init = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const ctx = canvas.getContext("2d");

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };

  resize();
  window.addEventListener("resize", resize);

  // 创建粒子
  const particleCount = Math.floor((canvas.width * canvas.height) / 15000);
  particles = [];
  for (let i = 0; i < particleCount; i++) {
    particles.push(new Particle(canvas));
  }

  // 动画循环
  const animate = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 绘制连线
    ctx.strokeStyle = "rgba(139, 92, 246, 0.05)";
    ctx.lineWidth = 0.5;

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < 150) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.globalAlpha = (1 - distance / 150) * 0.3;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // 绘制粒子
    particles.forEach((particle) => {
      particle.update();
      particle.draw(ctx);
    });

    animationId = requestAnimationFrame(animate);
  };

  animate();
};

onMounted(init);

onUnmounted(() => {
  if (animationId) {
    cancelAnimationFrame(animationId);
  }
});
</script>

<style scoped>
.particle-canvas {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}
</style>
