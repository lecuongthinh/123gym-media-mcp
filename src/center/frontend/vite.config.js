import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Mặc định phục vụ ở gốc domain ("/") như trước giờ — khi bị gắn vào 1 app khác dưới 1 tiền tố đường dẫn
// (vd /center/*), build bằng VITE_BASE_PATH=/center/ để các thẻ <script>/<link> trong index.html trỏ đúng
// chỗ thay vì luôn trỏ về gốc domain của app đang chứa nó.
export default defineConfig({ plugins: [react()], base: process.env.VITE_BASE_PATH || "/", build: { outDir: "../app/dist" } });
