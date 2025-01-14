# RowBoat monorepo

This is the monorepo for RowBoat.

## Setup and Run

To set up and run RowBoat, follow these steps:

1. **Create a `.env` File:**

   First, create a `.env` file in the root directory of the project. You can use the `.env.example` file as a template. Copy the contents of `.env.example` and replace the placeholder values with your actual configuration values.

   ```bash
   cp .env.example .env
   ```

   Edit the `.env` file to include your specific API keys and secrets.

2. **Build and Run Service:**

   Use Docker Compose to build and run the RowBoat service:

   ```bash
   docker-compose up --build
   ```

   This command will build the Docker image and start the service.

3. **Access the Application:**

   Once the service is running, you can access RowBoat via:

   - `http://localhost:3000`
