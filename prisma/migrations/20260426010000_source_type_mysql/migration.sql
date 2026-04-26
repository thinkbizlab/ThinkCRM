-- Add MYSQL value to SourceType enum so IntegrationSource rows can hold direct-DB
-- pull configurations. configJson holds the connection details + query mode.
ALTER TYPE "SourceType" ADD VALUE 'MYSQL';
