import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1751058000000 implements MigrationInterface {
  name = 'CreateVideos1751058000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" (` +
        `"id" uuid NOT NULL DEFAULT uuid_generate_v4(), ` +
        `"slug" character varying(11) NOT NULL, ` +
        `"title" character varying(200) NOT NULL, ` +
        `"status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', ` +
        `"storage_key" character varying(500), ` +
        `"thumbnail_key" character varying(500), ` +
        `"duration_seconds" integer, ` +
        `"metadata" jsonb, ` +
        `"error_message" character varying(1000), ` +
        `"channel_id" uuid NOT NULL, ` +
        `"created_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `"updated_at" TIMESTAMP NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "UQ_videos_slug" UNIQUE ("slug"), ` +
        `CONSTRAINT "PK_videos" PRIMARY KEY ("id")` +
        `)`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channel_id"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
