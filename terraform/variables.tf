variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  default     = "production"
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.medium"
}

variable "db_username" {
  description = "Database administrator username"
  type        = string
  default     = "soulzaa"
}

variable "db_password" {
  description = "Database administrator password"
  type        = string
  sensitive   = true
}
