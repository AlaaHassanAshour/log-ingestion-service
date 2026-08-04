<<<<<<< HEAD
# log-ingestion-service
=======
# 🚀 High-Performance Log Ingestion & Querying Service

A scalable, production-ready Log Ingestion and Search service built with **Node.js (TypeScript)**, **Fastify**, and **PostgreSQL**. Engineered for high throughput, memory efficiency, structural dynamic data validation, and automated daily table partitioning.

---

## ✨ Features

- **⚡ High Throughput Ingestion:** Supports single and batch log ingestion using parameterized bulk insert queries.
- **📅 Dynamic PostgreSQL Partitioning:** Automatically creates and manages daily partitions (`logs_YYYY_MM_DD`) to optimize query performance and data maintenance.
- **🛡️ Strict Schema Validation:** Utilizes **Zod** to validate incoming log formats and payload structures.
- **🔍 Advanced Querying & Pagination:** Offers filtered log retrieval by `service`, `level`, `timestamp` range, and full-text searching (`q`) with limit/offset support.
- **📚 Interactive API Documentation:** Auto-generated **Swagger / OpenAPI** documentation interface at `/documentation`.
- **🧪 Comprehensive Integration Tests:** Automated testing pipeline using **Vitest** and **Supertest**.
- **🐳 Production-Ready Docker Setup:** Containerized environment leveraging multi-stage Docker builds and docker-compose.

---

## 🏗️ Architecture & Database Design

The database schema utilizes **PostgreSQL Declarative Table Partitioning** by range on the `timestamp` column.

- **Primary Table:** `logs` (Partitioned Master Table)
- **Daily Partitions:** `logs_YYYY_MM_DD` (Automatically created via PL/pgSQL triggers/functions)
- **Indexes:** Composite index on `(service, timestamp DESC)` and `GIN` trigram indexing on `message` for fast filtering and search performance.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js v20+](https://nodejs.org/)
- [Docker & Docker Compose](https://www.docker.com/)

### 1️⃣ Clone & Install Dependencies

```bash
git clone [https://github.com/YOUR_USERNAME/log-ingestion-service.git](https://github.com/YOUR_USERNAME/log-ingestion-service.git)
cd log-ingestion-service
npm install

2️⃣ Running with Docker Compose
 (Recommended)To start the database and application containers:
 Bashdocker compose up --build
 The service will be available at http://localhost:8080.

📖 API Documentation & Swagger
Once the application is running, open your browser and navigate to:
👉 http://localhost:8080/documentation
Here you can interactively test the API endpoints (POST /api/logs, GET /api/logs, GET /health).

🧪 Running Integration Tests
Make sure the PostgreSQL instance is running, then execute

npm test

🛠️ Built With
Runtime: Node.js (TypeScript)

Framework: Fastify

Database: PostgreSQL 16

Validation: Zod

Documentation: @fastify/swagger & @fastify/swagger-ui

Testing: Vitest & Supertest

DevOps: Docker & Docker Compose
>>>>>>> 59fdbc3 (feat: complete log ingestion service with partitioning, fastify, swagger, and vitest)
